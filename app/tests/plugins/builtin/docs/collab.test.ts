// Two members typing in the same docs page at once: both edits survive and both copies end up the same.
import { describe, expect, it } from "vitest";
import { ApiClient } from "../../../../src/api/client";
import { MockBackend } from "../../../../src/system/backend";
import { docs } from "../../../../src/system/docs";
import { MockTransport } from "../../../../src/mock/transport";
import { openPageText } from "../../../../src/plugins/builtin/docs/collab";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("docs live text", () => {
  it("merges edits made at the same time", async () => {
    const backend = new MockBackend();
    backend.load(docs);
    const client = () => new ApiClient(new MockTransport(backend, 0)).plugin("docs");
    const setup = client();
    const { id } = await setup.call<{ id: number }>("add-page", { channel_id: 1, title: "Notes", body: "one two" });
    const errors: unknown[] = [];
    const open = () => openPageText(client(), id, async () => "one two", { caretOf: () => undefined, onError: (e) => errors.push(e) });
    const a = open();
    const b = open();
    await sleep(50);
    expect([a.text(), b.text()]).toEqual(["one two", "one two"]);
    // Both type before either has saved.
    a.edit("zero one two");
    b.edit("one two three");
    await Promise.all([a.flush(), b.flush()]);
    await sleep(100);
    expect(a.text()).toBe("zero one two three");
    expect(b.text()).toBe("zero one two three");
    const { page } = await setup.call<{ page: { body: string } }>("get-page", { page_id: id });
    expect(page.body).toBe("zero one two three");
    expect(errors).toEqual([]);
    await a.close();
    await b.close();
  });
});
