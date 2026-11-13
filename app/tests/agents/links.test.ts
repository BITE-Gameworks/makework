import { describe, expect, it } from "vitest";
import { withLinks } from "../../src/agents/links";
import type { BotContext } from "../../src/plugins/types";
import { butlerName, copName, robotName, superAiName } from "../../src/plugins/builtin/bots/identity";

const context = { workspaceId: "w1", member: (id: number) => ({ displayName: id === 5 ? "Ann" : "Bob" }), channels: async () => [{ id: 7, name: "Code", type: "code" }, { id: 8, name: "refs", type: "artboard" }] } as unknown as BotContext;

describe("agent links", () => {
  it("links known channels, leaving code spans, existing links and unknown names alone", async () => {
    expect(await withLinks(context, "Wrote it in #code and #refs, not #nowhere. `#code` stays. [#code](https://x.y) too."))
      .toBe("Wrote it in [#code](makework://w1/7) and [#refs](makework://w1/8), not #nowhere. `#code` stays. [#code](https://x.y) too.");
  });
});

describe("agent mentions", () => {
  it("shows quoted mentions as names and keeps only the ones meant to ping", async () => {
    expect(await withLinks(context, "<@5> Bob said <@6> is on it", [5])).toBe("<@5> Bob said @Bob is on it");
  });
});

describe("bot names", () => {
  it("pick a name per seed, from each type's own list", () => {
    for (const name of [butlerName, copName, robotName, superAiName]) {
      expect(name(1)).toBeTruthy();
      expect(name(1)).toBe(name(1));
      expect(new Set([...Array(40).keys()].map(name)).size).toBeGreaterThan(25);
    }
  });
});
