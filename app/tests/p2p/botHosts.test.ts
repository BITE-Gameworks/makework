import { afterEach, describe, expect, it } from "vitest";
import { BotHostChannel } from "../../src/p2p/botHosts";
import type { WorkspaceSync } from "../../src/p2p/sync";

type Message = { device: string; running: [number, number][] };

const channels: BotHostChannel[] = [];
afterEach(() => channels.splice(0).forEach((c) => c.close()));

function channel() {
  const sent: Message[] = [];
  let deliver: (message: Message) => void = () => {};
  const sync = {
    mesh: { channel: (_name: string, handler: (message: Message) => void) => { deliver = handler; return (m: Message) => sent.push(m); } },
    onPeers: () => () => {},
  } as unknown as WorkspaceSync;
  const link = new BotHostChannel("w", sync);
  channels.push(link);
  let changes = 0;
  link.onChange(() => changes++);
  return { link, sent, deliver: (m: Message) => deliver(m), changes: () => changes };
}

describe("bot host announcements", () => {
  it("reacts to another device's list only when it changes", () => {
    const { link, deliver, changes } = channel();
    deliver({ device: "other", running: [[1, 100]] });
    deliver({ device: "other", running: [[1, 100]] });
    expect(changes()).toBe(1);
    deliver({ device: "other", running: [[1, 100], [2, 200]] });
    expect(changes()).toBe(2);
    deliver({ device: "other", running: [[1, 100], [2, 300]] });
    expect(changes()).toBe(3);
    expect(link.claims().get(2)).toEqual([{ device: "other", since: 300 }]);
  });

  it("sends its own list only when it changes", () => {
    const { link, sent } = channel();
    link.announce(new Map());
    expect(sent).toHaveLength(0);
    link.announce(new Map([[1, 100]]));
    link.announce(new Map([[1, 100]]));
    expect(sent).toHaveLength(1);
    link.announce(new Map());
    expect(sent.map((m) => m.running)).toEqual([[[1, 100]], []]);
  });

  it("two devices answering each other's announcements settle", () => {
    const a = channel();
    const b = channel();
    // Each answers a change with its own list, as the bot runner does after reconciling.
    a.link.onChange(() => a.link.announce(new Map([[1, 100]])));
    b.link.onChange(() => b.link.announce(new Map([[2, 200]])));
    let rounds = 0;
    a.link.announce(new Map([[1, 100]]));
    while ((a.sent.length || b.sent.length) && rounds++ < 50) {
      for (const m of a.sent.splice(0)) b.deliver({ ...m });
      for (const m of b.sent.splice(0)) a.deliver({ ...m });
    }
    expect(rounds).toBeLessThan(5);
  });
});
