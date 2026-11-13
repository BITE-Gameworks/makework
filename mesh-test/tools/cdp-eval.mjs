#!/usr/bin/env node
// Evaluates one expression in a MakeWork client's page over the Chrome DevTools Protocol (raw CDP, Node 22+, no deps).
//
//   node cdp-eval.mjs <cdp-url> <expression | -> [--console <seconds>] [--timeout <seconds>] [--ready]
//
// <cdp-url>       e.g. http://10.231.1.101:9223 (an IP: DevTools rejects other Host names), or http://127.0.0.1:9222
//                 inside the client container.
// <expression>    awaited; prints its value as JSON. "-" reads it from stdin. Wrap statements in (async () => {...})().
// --console N     also prints the page's console output (to stderr) from the start of the evaluation until N
//                 seconds after it finished.
// --ready         no expression: exits 0 once the app page has loaded (document complete), 1 if it isn't up yet.
// Exit codes: 0 ok, 1 not reachable / not ready, 2 the expression threw.
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [, value] = args.splice(i, 2);
  return value;
};
const ready = args.includes("--ready") && (args.splice(args.indexOf("--ready"), 1), true);
const consoleSeconds = Number(flag("--console") ?? 0);
const timeoutSeconds = Number(flag("--timeout") ?? 120);
const [base, source] = args;
if (!base || (!ready && !source)) {
  console.error("usage: cdp-eval.mjs <cdp-url> <expression | -> [--console <seconds>] [--timeout <seconds>] [--ready]");
  process.exit(1);
}

// On any port: topology lan serves the app on 1421 (the developer's own dev server has 1420).
const appPage = (t) => t.type === "page" && /^http:\/\/localhost(:\d+)?\//.test(t.url);

async function target() {
  const response = await fetch(new URL("/json/list", base), { signal: AbortSignal.timeout(5000) });
  const list = await response.json();
  return list.find(appPage) ?? null;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = [];
    let next = 1;
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const id = next++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
        on(listener) {
          listeners.push(listener);
        },
        close() {
          ws.close();
        },
      });
    ws.onerror = () => reject(new Error(`CDP websocket failed: ${url}`));
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(message.error.message));
        else res(message.result);
      } else if (message.method) listeners.forEach((l) => l(message));
    };
  });
}

function text(arg) {
  if (arg.type === "string") return arg.value;
  if ("value" in arg) return JSON.stringify(arg.value);
  return arg.description ?? arg.type;
}

let page;
try {
  page = await target();
} catch (e) {
  console.error(`not reachable: ${e.message}`);
  process.exit(1);
}
if (!page) {
  console.error("no app page target yet");
  process.exit(1);
}

const cdp = await connect(page.webSocketDebuggerUrl);
const timer = setTimeout(() => {
  console.error(`timed out after ${timeoutSeconds} s`);
  process.exit(2);
}, timeoutSeconds * 1000);

if (ready) {
  const result = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
  clearTimeout(timer);
  cdp.close();
  process.exit(result.result?.value === "complete" ? 0 : 1);
}

if (consoleSeconds > 0) {
  cdp.on((message) => {
    if (message.method !== "Runtime.consoleAPICalled") return;
    const { type, args: values, timestamp } = message.params;
    console.error(`[console.${type} ${new Date(timestamp).toISOString()}] ${values.map(text).join(" ")}`);
  });
  await cdp.send("Runtime.enable");
}

const expression = source === "-" ? await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data));
}) : source;

const result = await cdp.send("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});
let code = 0;
if (result.exceptionDetails) {
  const details = result.exceptionDetails;
  console.error(`threw: ${details.exception?.description ?? details.text}`);
  code = 2;
} else {
  console.log(JSON.stringify(result.result?.value ?? null));
}
if (consoleSeconds > 0) await new Promise((resolve) => setTimeout(resolve, consoleSeconds * 1000));
clearTimeout(timer);
cdp.close();
process.exit(code);
