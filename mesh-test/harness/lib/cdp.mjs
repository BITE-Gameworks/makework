// One MakeWork client reached over CDP (playwright-core connectOverCDP to Electron's remote debugging port).
// DevTools only answers Host headers that are an IP or localhost, so clients are addressed by IP.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { log, sleep, withTimeout } from "./util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// MWT_EXPERIMENTS (comma list, e.g. "dedupe") turns on in-page experiments in instrument.js; off by default.
const experiments = (process.env.MWT_EXPERIMENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export const instrumentSource = `window.__mwtExperiments = ${JSON.stringify(experiments)};\n` +
  fs.readFileSync(path.join(here, "instrument.js"), "utf8");

const isAppUrl = (url) => /^(https?:\/\/localhost(:\d+)?\/|app:\/\/makework\/)/.test(url);

export class Client {
  // spec: { name, cdp: "http://<ip>:<port>", lans, ips }
  constructor(spec) {
    this.name = spec.name;
    this.spec = spec;
    this.cdp = spec.cdp;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.connected = false;
    // Set by scenarios while the client is cut off or restarting, so the poller leaves it alone.
    this.down = false;
    this.logCursor = 0;
    this.username = null;
    this.selfId = null;
  }

  async versionInfo(timeoutMs = 3000) {
    const res = await withTimeout(fetch(`${this.cdp}/json/version`), timeoutMs, `${this.name} /json/version`);
    if (!res.ok) throw new Error(`${this.name}: /json/version HTTP ${res.status}`);
    return res.json();
  }

  // Waits for the DevTools endpoint, attaches, installs the instrumentation and finds the app page.
  // reload: "always" reloads the page (fresh counters for a new run), true reloads only a page that ran without
  // instrumentation, false injects it late instead (keeps a restarted client's boot undisturbed).
  async connect({ timeoutMs = 180_000, reload = true } = {}) {
    const until = Date.now() + timeoutMs;
    let info = null;
    let lastError = null;
    while (Date.now() < until) {
      try {
        info = await this.versionInfo();
        break;
      } catch (e) {
        lastError = e;
        await sleep(500);
      }
    }
    if (!info) throw new Error(`${this.name}: DevTools not reachable at ${this.cdp}: ${lastError?.message}`);
    // The ws URL is built from our Host header; make sure it points at the reachable address anyway.
    const endpoint = new URL(this.cdp);
    const ws = new URL(info.webSocketDebuggerUrl);
    ws.hostname = endpoint.hostname;
    ws.port = endpoint.port;

    this.browser = await chromium.connectOverCDP(ws.toString(), { timeout: 30_000 });
    this.connected = true;
    this.browser.on("disconnected", () => {
      this.connected = false;
    });
    this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
    await this.context.addInitScript({ content: instrumentSource });

    this.page = await this.findPage(Math.max(10_000, until - Date.now()));
    await this.page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
    const instrumented = await this.page.evaluate(() => Boolean(window.__mwt)).catch(() => false);
    if (!instrumented || reload === "always") {
      if (reload) {
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        this.logCursor = 0;
      } else {
        await this.page.evaluate(instrumentSource);
      }
    }
    await this.waitForApp();
    // A headless or tiny window (Ozone headless gives 1x1) leaves every element "outside of the viewport" for
    // clicks; give the page a desktop-sized viewport (layout only, through CDP Emulation).
    const width = await this.page.evaluate(() => innerWidth).catch(() => 0);
    if (width < 1000) await this.page.setViewportSize({ width: 1280, height: 800 }).catch((e) => log(`${this.name}: viewport not set: ${e.message}`));
    const patch = await this.page.evaluate(async () => window.__mwt?.patch?.()).catch((e) => ({ error: String(e) }));
    const early = await this.page.evaluate(() => window.__mwt?.early ?? null).catch(() => null);
    log(`${this.name}: connected (${info.Browser ?? "?"}), instrumentation early=${early}, patch=${JSON.stringify(patch)}`);
    return { info, patch, early };
  }

  async findPage(timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const page = this.context.pages().find((p) => isAppUrl(p.url()));
      if (page) return page;
      await sleep(300);
    }
    const urls = this.context.pages().map((p) => p.url());
    throw new Error(`${this.name}: no app page found (pages: ${JSON.stringify(urls)})`);
  }

  // The app's modules answer once Vite has served them and the page has started.
  async waitForApp(timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
      try {
        const ok = await withTimeout(
          this.page.evaluate(async () => {
            const a = await import("/src/core/account.ts");
            return typeof a.register === "function";
          }),
          15_000,
          `${this.name} app modules`,
        );
        if (ok) return;
      } catch (e) {
        last = e;
      }
      await sleep(1000);
    }
    throw new Error(`${this.name}: app modules did not load: ${last?.message ?? last}`);
  }

  // page.evaluate with a timeout; throws on failure.
  async eval(fn, arg, timeoutMs = 30_000, what = "evaluate") {
    if (!this.page) throw new Error(`${this.name}: not connected`);
    return withTimeout(this.page.evaluate(fn, arg), timeoutMs, `${this.name} ${what}`);
  }

  async close() {
    try {
      // Detaches only; the client keeps running. A dead connection (killed or cut off) must not hang here.
      if (this.browser) await withTimeout(this.browser.close(), 5000, `${this.name} close`);
    } catch {}
    this.browser = null;
    this.connected = false;
  }

  async reconnect(opts = {}) {
    await this.close();
    return this.connect({ reload: false, ...opts });
  }
}

// Connects to every client in parallel; failures are returned, not thrown.
export async function connectAll(clients, opts = {}) {
  const results = await Promise.all(
    clients.map(async (c) => {
      try {
        await c.connect(opts);
        return { name: c.name, ok: true };
      } catch (e) {
        log(`${c.name}: connect failed: ${e.message}`);
        return { name: c.name, ok: false, error: e.message };
      }
    }),
  );
  return results;
}
