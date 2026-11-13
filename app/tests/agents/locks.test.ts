import { describe, expect, it } from "vitest";
import { claim, releaseAll } from "../../src/agents/locks";
import type { BotContext } from "../../src/plugins/types";

const bot = (id: number, nickname: string, remote: { userId: number; key: string; value: unknown }[] = []) => {
  const marks: [string, unknown][] = [];
  const context = {
    workspaceId: "w", bot: { id, nickname }, member: (user: number) => ({ displayName: `member ${user}` }),
    mark: (_: number, key: string, value: unknown) => marks.push([key, value]), marks: () => remote,
  } as unknown as BotContext;
  return { context, marks };
};

describe("soft locks", () => {
  it("lets one bot hold an object, tells the other who has it, and frees it when released", () => {
    const a = bot(1, "Ann bot");
    const b = bot(2, "Ben bot");
    expect(claim(a.context, 5, 10)).toBeNull();
    expect(claim(a.context, 5, 10)).toBeNull();
    expect(claim(b.context, 5, 10)).toBe("Ann bot");
    expect(claim(b.context, 5, 11)).toBeNull();
    releaseAll(a.context);
    expect(a.marks.at(-1)).toEqual(["lock:10", null]);
    expect(claim(b.context, 5, 10)).toBeNull();
    releaseAll(b.context);
  });

  it("respects a claim shown by a bot on another device, until it lapses", () => {
    const remote = bot(3, "Cy bot", [{ userId: 99, key: "lock:7", value: Date.now() + 10_000 }]);
    expect(claim(remote.context, 6, 7)).toBe("member 99");
    const lapsed = bot(4, "Di bot", [{ userId: 99, key: "lock:7", value: Date.now() - 1 }]);
    expect(claim(lapsed.context, 6, 7)).toBeNull();
    releaseAll(lapsed.context);
  });
});
