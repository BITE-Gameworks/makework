import { beforeAll, describe, expect, it } from "vitest";
import { channelType } from "../../../src/core/channelTypes";
import { channelTypesPlugin } from "../../../src/plugins/builtin/channelTypes";
import { registerBuiltIn } from "../../../src/plugins/registry";

beforeAll(() => registerBuiltIn(channelTypesPlugin));

describe("standard channel types", () => {
  it("keeps voice channels in the main window", () => {
    expect(channelType("voice").ownWindow).toBe(false);
  });

  it("lets other channel types have their own window", () => {
    expect(channelType("chat").ownWindow).not.toBe(false);
  });
});
