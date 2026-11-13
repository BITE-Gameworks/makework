import { describe, expect, it } from "vitest";
import { text } from "../../src/system/values";
import { decodeEmoji, emojiNameProblem, encodeEmoji, splitEmoji } from "../../src/markdown/emoji";
import { emojiCategories } from "../../src/markdown/emojiData";

describe("emoji shortcodes", () => {
  const samples = ["hi \u{1F604}", "\u{1F9D1}\u{200D}\u{1F4BB} works", "1\u{FE0F}\u{20E3} keycap", "flag \u{1F1EB}\u{1F1F7}", "plain"];

  it("round-trips and passes the text value check", () => {
    for (const sample of samples) {
      const encoded = encodeEmoji(sample);
      expect(() => text(encoded)).not.toThrow();
      expect(decodeEmoji(encoded)).toBe(sample);
    }
  });

  it("encodes each emoji on its own", () => {
    expect(encodeEmoji("\u{1F44E}\u{1F680}\u{1F389}")).toBe(":thumbsdown::rocket::tada:");
  });

  it("uses names when known and leaves unknown words alone", () => {
    expect(encodeEmoji("\u{1F604}")).toBe(":smile:");
    expect(splitEmoji("a :nope: b")).toEqual([{ text: "a :nope: b" }]);
  });

  it("stores every picker emoji by a name that survives the text value check", () => {
    const names = new Set<string>();
    for (const [name, emoji] of emojiCategories.flatMap((c) => c.emoji)) {
      expect(names.has(name), name).toBe(false);
      names.add(name);
      const encoded = encodeEmoji(emoji);
      expect(encoded, name).toMatch(/^:[a-z0-9_]+:$/);
      expect(() => text(encoded)).not.toThrow();
      expect(decodeEmoji(encoded)).toBe(emoji);
    }
  });
});

describe("custom emoji shortcodes", () => {
  const custom = (name: string) => name === "party_parrot";

  it("keeps a custom shortcode as its own part", () => {
    expect(splitEmoji("hi :party_parrot:!", custom)).toEqual([
      { text: "hi " },
      { custom: "party_parrot", code: "party_parrot" },
      { text: "!" },
    ]);
  });

  it("keeps standard emoji and unknown words as before", () => {
    expect(splitEmoji(":smile: :party_parrot: :nope:", custom)).toEqual([
      { emoji: "\u{1F604}", code: "smile" },
      { text: " " },
      { custom: "party_parrot", code: "party_parrot" },
      { text: " :nope:" },
    ]);
  });

  it("leaves custom shortcodes alone when decoding text", () => {
    expect(decodeEmoji(":party_parrot: :smile:")).toBe(":party_parrot: \u{1F604}");
  });

  it("checks custom emoji names", () => {
    expect(emojiNameProblem("party_parrot")).toBeNull();
    expect(emojiNameProblem("smile")).toMatch(/standard/);
    expect(emojiNameProblem("u1f600")).toMatch(/standard/);
    expect(emojiNameProblem("x")).toMatch(/2-32/);
    expect(emojiNameProblem("Party")).toMatch(/2-32/);
    expect(emojiNameProblem("party-parrot")).toMatch(/2-32/);
    expect(emojiNameProblem("party parrot")).toMatch(/2-32/);
  });
});
