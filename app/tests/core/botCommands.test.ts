import { describe, expect, it } from "vitest";
import { commandArgs, parseBotCommand } from "../../src/core/botCommands";

describe("parseBotCommand", () => {
  it("reads a command after the mention", () => {
    expect(parseBotCommand("<@7> /roll 2d6", 7)).toEqual({ name: "roll", args: "2d6" });
    expect(parseBotCommand("/when 3pm Berlin <@7>", 7)).toEqual({ name: "when", args: "3pm Berlin" });
  });
  it("treats a bare mention as no command", () => {
    expect(parseBotCommand("hey <@7> what's up", 7)?.name).toBe("");
    expect(parseBotCommand("<@7>", 7)).toEqual({ name: "", args: "" });
  });
  it("ignores messages that don't mention the bot", () => {
    expect(parseBotCommand("<@8> /roll", 7)).toBeNull();
  });
  it("lists the members named in the arguments", () => {
    expect(commandArgs("<@5> and <@6> now").mentioned).toEqual([5, 6]);
  });
});
