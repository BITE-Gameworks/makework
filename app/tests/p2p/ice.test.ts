import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/account", () => ({ account: () => ({ id: "account" }), accountKey: () => ({}) }));
vi.mock("../../src/core/userServer", () => ({
  authHeader: async () => "signed",
  hostOf: (url: string) => url,
  normalizeUrl: (url: string) => (url.includes("://") ? url : `https://${url}/`),
}));

const minute = 60_000;
const servers = [{ urls: "turn:turn.example:3478", username: "u", credential: "c" }];

// The worker: credentials for 30 minutes, or a refusal that says when to ask again.
function worker(answers: { iceServers?: unknown[]; ttl?: number; reason?: string }[]) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(answers.shift() ?? { iceServers: servers, ttl: 1800 })));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function ice() {
  vi.resetModules();
  return import("../../src/p2p/ice");
}

describe("TURN credentials", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("are fetched when a server opens and not again while fresh, not even in the background", async () => {
    const fetch = worker([]);
    const { loadTurn, currentTurn } = await ice();
    await loadTurn();
    await loadTurn();
    expect(currentTurn()).toEqual(servers);
    await vi.advanceTimersByTimeAsync(19 * minute);
    expect(currentTurn()).toEqual(servers);
    await vi.advanceTimersByTimeAsync(60 * minute);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("are asked for again after an answer without a lifetime or servers, instead of never", async () => {
    const fetch = worker([{ reason: "busy" }, { iceServers: servers }, {}]);
    const { loadTurn, currentTurn } = await ice();
    await loadTurn();
    expect(currentTurn()).toEqual([]);
    vi.setSystemTime(1.5 * minute);
    await loadTurn();
    // Servers without a lifetime aren't used, and the next connection asks again a minute later.
    expect(currentTurn()).toEqual([]);
    vi.setSystemTime(3 * minute);
    currentTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("are renewed once when a connection is made after they got old, and not used once they ran out", async () => {
    const fetch = worker([{ iceServers: servers, ttl: 1800 }, { iceServers: [], ttl: 600 }]);
    const { loadTurn, currentTurn } = await ice();
    await loadTurn();
    vi.setSystemTime(21 * minute);
    expect(currentTurn()).toEqual(servers);
    expect(currentTurn()).toEqual(servers);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);

    // Refused at minute 21 (ask again in 10): the old ones last until they run out at 30, nobody asks before 31.
    vi.setSystemTime(30.5 * minute);
    expect(currentTurn()).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.setSystemTime(32 * minute);
    currentTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  // A call goes only over direct links (ADR 0019): without TURN, callers behind strict NATs can't link at all, so call
  // diagnostics say whether this device has the credentials, or why not.
  it("say whether this device has them now, or why not", async () => {
    worker([{ iceServers: [], ttl: 600, reason: "monthly cap reached" }, { iceServers: servers, ttl: 1800 }]);
    const { loadTurn, turnStatus } = await ice();
    expect(turnStatus()).toBe("not asked for yet");
    await loadTurn();
    expect(turnStatus()).toBe("not given: monthly cap reached");
    vi.setSystemTime(11 * minute);
    await loadTurn();
    expect(turnStatus()).toBe("ready");
  });

  it("forget the last server's refusal when the address changes", async () => {
    worker([{ iceServers: [], ttl: 600, reason: "monthly cap reached" }]);
    const { loadTurn, setTurnServer, turnStatus } = await ice();
    await loadTurn();
    expect(turnStatus()).toBe("not given: monthly cap reached");
    setTurnServer("turn.other.example");
    expect(turnStatus()).toBe("not asked for yet");
  });
});
