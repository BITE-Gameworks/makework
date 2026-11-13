import { describe, expect, it } from "vitest";
import { loopbackOnce } from "../../electron/loopback.js";

describe("loopbackOnce", () => {
  it("answers the first accepted request on its path, then stops listening", async () => {
    let base = "";
    const flow = loopbackOnce({
      path: "/github",
      accept: (url) => url.searchParams.get("once") === "abc",
      page: () => ({ ok: true, title: "Done", message: "Close this tab." }),
      timeoutMs: 5000,
      open: (b) => { base = b; },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${base}/other?once=abc`)).status).toBe(404);
    expect((await fetch(`${base}/github?once=wrong`)).status).toBe(404);
    const reply = await fetch(`${base}/github?once=abc`);
    expect(await reply.text()).toContain("Done");
    const url = await flow.promise;
    expect(url.searchParams.get("once")).toBe("abc");
    await expect(fetch(`${base}/github?once=abc`)).rejects.toThrow();
  });

  it("rejects when cancelled", async () => {
    const flow = loopbackOnce({ path: "/", accept: () => true, page: () => ({ ok: true, title: "", message: "" }), timeoutMs: 5000, open: () => {} });
    flow.cancel();
    await expect(flow.promise).rejects.toThrow(/cancelled/);
  });

  it("rejects when opening the browser fails", async () => {
    const flow = loopbackOnce({ path: "/", accept: () => true, page: () => ({ ok: true, title: "", message: "" }), timeoutMs: 5000, open: () => { throw new Error("no browser"); } });
    await expect(flow.promise).rejects.toThrow(/no browser/);
  });

  it("escapes the page's title and message", async () => {
    let base = "";
    const flow = loopbackOnce({ path: "/", accept: () => true, page: () => ({ ok: false, title: "<b>&", message: "<i>" }), timeoutMs: 5000, open: (b) => { base = b; } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = await (await fetch(`${base}/`)).text();
    expect(text).toContain("&lt;b&gt;&amp;");
    expect(text).toContain("&lt;i&gt;");
    expect(text).not.toContain("<b>&");
    await flow.promise;
  });
});
