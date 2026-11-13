import { describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client";
import { MockBackend } from "../../src/system/backend";
import { watch } from "../../src/system/watch";
import { MockTransport } from "../../src/mock/transport";

const ref = `mwc:${"a".repeat(64)}`;

function setup() {
  const backend = new MockBackend({ userId: 7 });
  backend.load(watch);
  return new ApiClient(new MockTransport(backend)).plugin("watch");
}

describe("watch plugin", () => {
  it("plans a party, plays it and ends it", async () => {
    const api = setup();
    const { id } = await api.call<{ id: number }>("create-party", {
      channel_id: 3, chat_channel_id: 4, title: "Movie night", starts_at: new Date().toISOString(),
      items: JSON.stringify([{ file_id: 9, name: "a.mp4", url: ref, mime: "video/mp4", size: 100 }]),
    });
    await api.call("set-message", { party_id: id, message_id: 11 });
    await api.call("set-playback", { party_id: id, item: 0, playing: true, position: 12.5 });
    const { party } = await api.call<{ party: Record<string, unknown> }>("get-party", { party_id: id });
    expect(party).toMatchObject({ title: "Movie night", message_id: 11, playing: true, guests: [7] });
    expect(Number(party.position)).toBe(12.5);
    await api.call("end-party", { party_id: id });
  });
});
