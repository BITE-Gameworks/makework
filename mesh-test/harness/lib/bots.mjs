// Headless bot members (mesh-test/bot, image mwt-node) over their HTTP control port. A BotClient looks enough like
// a CDP Client for the poller and trackers: `name`, `isBot`, `down`, `lastState` with the probe's shape
// ({ t, servers: { id: { hasData, commits, online, members, seen, seenPrefix } } }).
import { attempt, mapLimit } from "./util.mjs";

export class BotClient {
  constructor(spec) {
    this.name = spec.name;
    this.spec = spec;
    this.url = spec.url;
    this.isBot = true;
    this.connected = true;
    this.down = false;
    this.lastState = null;
  }

  async get(path, timeoutMs = 10_000) {
    const res = await fetch(`${this.url}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    if (!res.ok) throw new Error(`${this.name} GET ${path}: ${body?.error ?? res.status}`);
    return body;
  }

  async post(path, input, timeoutMs = 60_000) {
    const res = await fetch(`${this.url}${path}`, {
      method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${this.name} POST ${path}: ${body?.error ?? res.status}`);
    return body;
  }

  // For the poller (metrics.mjs pollOne).
  probe(serverIds, prefixes = {}) {
    const wanted = Object.fromEntries(serverIds.filter((id) => prefixes[id]).map((id) => [id, prefixes[id]]));
    return this.get(`/status?prefixes=${encodeURIComponent(JSON.stringify(wanted))}`, 8_000);
  }

  join(invite) {
    return this.post("/join", { invite });
  }

  leave(serverId) {
    return this.post("/leave", { serverId });
  }

  // Same result shape as driver.postTagged.
  postTagged(serverId, tags, gapMs = 0) {
    return this.post("/post", { serverId, tags, gapMs }, Math.max(60_000, tags.length * (gapMs + 3000)));
  }

  fetchFiles(serverId) {
    return this.post("/fetch", { serverId });
  }

  seenTimes(serverId, prefix) {
    return this.get(`/seen?server=${encodeURIComponent(serverId)}&prefix=${encodeURIComponent(prefix)}`, 20_000);
  }

  ledgerInfo(serverId) {
    return this.get(`/ledger?server=${encodeURIComponent(serverId)}`, 30_000);
  }

  status() {
    return this.get("/status", 10_000);
  }
}

// Calls fn on every bot, a few at a time; returns { name: { ok, value | error } }.
export async function eachBot(bots, fn, limit = 25) {
  const out = {};
  await mapLimit(bots, limit, async (bot) => {
    out[bot.name] = await attempt(() => fn(bot));
  });
  return out;
}
