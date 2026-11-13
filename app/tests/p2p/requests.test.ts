// A request/answer action between two peers of a room (src/p2p/requests.ts): the one typed wrapper over Trystero's
// request actions, so callers never restate the shape by hand.
import { describe, expect, it } from "vitest";
import type { Room } from "trystero";
import { requestAction } from "../../src/p2p/requests";
import { Network } from "./fakeNetwork";

describe("requestAction", () => {
  it("asks one peer and gets its answer, which knows who asked", async () => {
    const network = new Network();
    const a = network.room("a", "hub") as unknown as Room;
    const b = network.room("b", "hub") as unknown as Room;
    network.link("a", "b", "hub");
    requestAction<{ n: number }, { twice: number; from: string }>(b, "double", ({ n }, { peerId }) => ({ twice: n * 2, from: peerId }));
    const ask = requestAction<{ n: number }, { twice: number; from: string }>(a, "double");
    expect(await ask.request({ n: 21 }, { target: "b", timeoutMs: 1000 })).toEqual({ twice: 42, from: "a" });
  });
});
