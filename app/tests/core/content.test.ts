import { afterEach, describe, expect, it } from "vitest";
import {
  canUploadToNode, forgetPresent, markFinished, markPresent, registerContentSync, transferBar, transferLabel, uploadAction, type ContentSync,
} from "../../src/core/content";

const hash = "a".repeat(64);
const url = `mwc:${hash}`;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

// A workspace's content sync with nothing arriving. `pending`: its uploads no node has all of yet, `reached`: whether
// a node is reached, `sending`: how far a send of them got, `toNode`: whether that send goes to a node, `got`: how far
// a node got with them before (kept while its pull pauses), `held`: uploads the user cancelled on their way to a node.
function workspace(options: { pending?: string[]; reached?: boolean; sending?: number; toNode?: boolean; got?: number; held?: string[] } = {}) {
  const pending = new Set(options.pending);
  const held = new Set(options.held);
  const sync = {
    status: () => undefined, progress: () => undefined, sending: () => options.sending,
    delivery: (h: string) => (held.has(h) ? "held" : pending.has(h) ? (options.reached ? "uploading" : "waiting") : undefined),
    deliveryProgress: (h: string) => (pending.has(h) ? options.got : undefined),
    sendingToNode: () => !!options.toNode,
  } as unknown as ContentSync;
  cleanups.push(registerContentSync("w", sync));
}

// A node pulls a new upload from its uploader after the post (p2p/deliveries.ts): until one has all of it the file says
// so, as quitting would cut it off.
describe("a new upload on its way to a node", () => {
  // The bar is there from the post on, empty until the node starts on the file: a node starts seconds after the post
  // and takes one file at a time, so with text alone most of a batch looked as if nothing was happening.
  it("has an empty bar and says it is uploading to the node while one is reached", () => {
    workspace({ pending: [hash], reached: true });
    expect(transferLabel("w", url)).toBe("Uploading to the node");
    expect(transferBar("w", url)).toEqual({ value: 0, label: "Uploading to the node", done: false });
    expect(transferLabel("w", `mwc:${"b".repeat(64)}`)).toBeUndefined();
    expect(transferBar("w", `mwc:${"b".repeat(64)}`)).toBeUndefined();
  });

  it("says it waits for the node while none is reached, without a bar", () => {
    workspace({ pending: [hash], reached: false, got: 0.4 });
    expect(transferLabel("w", url)).toBe("Waiting for the node");
    expect(transferBar("w", url)).toBeUndefined();
  });

  it("keeps its place while the node's pull pauses", () => {
    workspace({ pending: [hash], reached: true, got: 0.4 });
    expect(transferBar("w", url)).toEqual({ value: 0.4, label: "Uploading to the node 40%", done: false });
  });

  it("never goes back when a second node starts on it from the beginning", () => {
    workspace({ pending: [hash], reached: true, got: 0.4, sending: 0.1, toNode: true });
    expect(transferBar("w", url)).toEqual({ value: 0.4, label: "Uploading to the node 40%", done: false });
  });

  it("says how far it got while the node takes it in", () => {
    workspace({ pending: [hash], reached: true, sending: 0.42, toNode: true });
    expect(transferLabel("w", url)).toBe("Uploading to the node 42%");
    expect(transferBar("w", url)).toEqual({ value: 0.42, label: "Uploading to the node 42%", done: false });
  });

  it("doesn't say Uploaded while it goes on to a node", () => {
    const other = "c".repeat(64);
    workspace({ pending: [other], reached: true });
    markFinished(other, "uploaded");
    expect(transferBar("w", `mwc:${other}`)).toEqual({ value: 0, label: "Uploading to the node", done: false });
    expect(transferLabel("w", `mwc:${other}`)).toBe("Uploading to the node");
  });

  it("says Uploaded first while no node is reached", () => {
    const other = "d".repeat(64);
    workspace({ pending: [other], reached: false });
    markFinished(other, "uploaded");
    expect(transferBar("w", `mwc:${other}`)).toEqual({ value: 1, label: "Uploaded", done: true });
  });

  it("says it is on the node for a moment once a node has all of it", () => {
    workspace();
    markFinished(hash, "delivered");
    expect(transferBar("w", url)).toEqual({ value: 1, label: "On the node", done: true });
  });
});

// Cancelling an upload removes nothing: the file stays, and its upload to the nodes is held back until the user sends
// it on. (It used to remove the item for everyone and delete its content.)
describe("an upload the user cancelled on its way to a node", () => {
  it("says it is not on the node, without a bar, and can be sent on", () => {
    // A hash of its own: the one above still says "On the node" for its 4 s.
    const held = "9".repeat(64);
    workspace({ pending: [held], held: [held], reached: true, got: 0.4 });
    expect(transferLabel("w", `mwc:${held}`)).toBe("Not on the node");
    expect(transferBar("w", `mwc:${held}`)).toBeUndefined();
    expect(uploadAction("w", `mwc:${held}`)).toBe("resume");
  });

  it("can be cancelled while it is sent, and while it waits for a node", () => {
    workspace({ pending: [hash], reached: true });
    expect(uploadAction("w", url)).toBe("cancel");
    expect(uploadAction("w", `mwc:${"b".repeat(64)}`)).toBeUndefined();
    cleanups.splice(0).forEach((cleanup) => cleanup());
    workspace({ pending: [hash], reached: false });
    expect(uploadAction("w", url)).toBe("cancel");
    cleanups.splice(0).forEach((cleanup) => cleanup());
    workspace({ sending: 0.2 });
    expect(uploadAction("w", url)).toBe("cancel");
  });
});

// "Upload to the node" on any own file: offered where the sync says so, only for content on this device (there is
// nothing to send otherwise).
describe("sending an own file on to the nodes", () => {
  const offer = (yes: boolean) => cleanups.push(registerContentSync("w", { canUploadToNode: () => yes } as unknown as ContentSync));
  const here = "f".repeat(64);
  const gone = "8".repeat(64);
  // Known either way, so nothing looks in a content store (there is none under the test runner).
  markPresent(here);
  forgetPresent(gone);

  it("is offered for content on this device when the sync says so", () => {
    offer(true);
    expect(canUploadToNode("w", `mwc:${here}`, 20)).toBe(true);
    expect(canUploadToNode("w", `mwc:${gone}`, 20)).toBe(false);
    expect(canUploadToNode("w", null, 20)).toBe(false);
    expect(canUploadToNode("w", "https://example.com/file.bin", 20)).toBe(false);
  });

  it("is not offered when the sync says no, or without a sync", () => {
    offer(false);
    expect(canUploadToNode("w", `mwc:${here}`, 20)).toBe(false);
    cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(canUploadToNode("w", `mwc:${here}`, 20)).toBe(false);
  });
});

describe("content going to another device", () => {
  it("says uploading to the node for anything a node takes in, a new upload or not", () => {
    workspace({ sending: 0.5, toNode: true });
    expect(transferLabel("w", `mwc:${"e".repeat(64)}`)).toBe("Uploading to the node 50%");
  });

  it("says sending while a member takes it in", () => {
    workspace({ pending: [hash], sending: 0.42 });
    expect(transferLabel("w", `mwc:${"f".repeat(64)}`)).toBe("Sending 42%");
  });
});
