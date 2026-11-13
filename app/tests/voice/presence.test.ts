import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import { participants, watchVoice } from "../../src/voice/state";

function source() {
  let event = () => {};
  const pending: ((rows: Record<string, unknown>[]) => void)[] = [];
  const unsubscribe = vi.fn();
  const api = { plugin: () => ({
    read: () => new Promise<Record<string, unknown>[]>((resolve) => pending.push(resolve)),
    onEvent: (handler: () => void) => { event = handler; return unsubscribe; },
  }) } as unknown as ApiClient;
  return { api, pending, unsubscribe, changed: () => event() };
}

describe("call participant snapshots", () => {
  it("does not apply an older read after a newer participant update", async () => {
    const src = source();
    const initial = watchVoice("presence-ordered", src.api);
    src.changed();
    src.pending[1]([{ id: 2, user_id: 22, channel_id: 5 }]);
    await Promise.resolve();
    src.pending[0]([]);
    await initial;
    expect(participants("presence-ordered", 5).map((p) => p.userId)).toEqual([22]);
  });

  it("ignores pending reads and events from a replaced workspace connection", async () => {
    const old = source();
    const current = source();
    const before = watchVoice("presence-replaced", old.api);
    const after = watchVoice("presence-replaced", current.api);
    current.pending[0]([{ id: 3, user_id: 33, channel_id: 5 }]);
    await after;
    old.pending[0]([]);
    await before;
    old.changed();
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(old.pending).toHaveLength(1);
    expect(participants("presence-replaced", 5).map((p) => p.userId)).toEqual([33]);
  });
});
