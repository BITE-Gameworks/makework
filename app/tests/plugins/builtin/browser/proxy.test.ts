import { describe, expect, it } from "vitest";
import { createRewriter, fromBase64, proxyUrl, toBase64 } from "../../../../src/plugins/builtin/browser/proxy";
import { isBrowserMessage } from "../../../../src/plugins/builtin/browser/input";

const token = "0123456789abcdef0123456789abcdef";
const p = (url: string) => proxyUrl(token, url);
const decoded = (proxied: string) => new TextDecoder().decode(fromBase64(proxied.split("/").pop()!.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(proxied.split("/").pop()!.length / 4) * 4, "=")));

describe("browser resource proxy", () => {
  it("encodes the address in a url-safe path", () => {
    const url = "https://example.com/a b?x=ü&y=1";
    expect(p(url)).toMatch(/^mwbrowser:\/\/0123456789abcdef0123456789abcdef\/[A-Za-z0-9_-]+$/);
    expect(decoded(p(url))).toBe(url);
    expect(fromBase64(toBase64(new Uint8Array([0, 255, 128])))).toEqual(new Uint8Array([0, 255, 128]));
  });

  it("rewrites images and css resources in a snapshot and later changes, not links", () => {
    const rewrite = createRewriter(token);
    const snapshot = { type: 2, data: { node: { type: 0, childNodes: [
      { type: 2, id: 1, tagName: "img", attributes: { src: "https://a.com/x.png", srcset: "https://a.com/1.png 1x, https://a.com/2.png 2x" }, childNodes: [] },
      { type: 2, id: 2, tagName: "a", attributes: { href: "https://a.com/page", style: "background: url('https://a.com/bg.png')" }, childNodes: [] },
      { type: 2, id: 3, tagName: "style", attributes: {}, childNodes: [{ type: 3, id: 4, isStyle: true, textContent: "b { background: url(https://a.com/b.png) } i { background: url(data:image/png;base64,AA) }" }] },
    ] } } };
    const [out] = rewrite([snapshot]);
    const [img, a, style] = out.data.node.childNodes;
    expect(img.attributes.src).toBe(p("https://a.com/x.png"));
    expect(img.attributes.srcset).toBe(`${p("https://a.com/1.png")} 1x, ${p("https://a.com/2.png")} 2x`);
    expect(a.attributes.href).toBe("https://a.com/page");
    expect(a.attributes.style).toBe(`background: url('${p("https://a.com/bg.png")}')`);
    expect(style.childNodes[0].textContent).toBe(`b { background: url(${p("https://a.com/b.png")}) } i { background: url(data:image/png;base64,AA) }`);

    const change = { type: 3, data: { source: 0, adds: [], texts: [], attributes: [{ id: 1, attributes: { src: "https://a.com/y.png" } }, { id: 2, attributes: { href: "https://a.com/other" } }] } };
    const [changed] = rewrite([change]);
    expect(changed.data.attributes[0].attributes.src).toBe(p("https://a.com/y.png"));
    expect(changed.data.attributes[1].attributes.href).toBe("https://a.com/other");
  });

  it("removes what could run script, with or without the proxy", () => {
    for (const rewrite of [createRewriter(token), createRewriter(null)]) {
      const snapshot = { type: 2, data: { node: { type: 0, childNodes: [
        { type: 2, id: 1, tagName: "img", attributes: { alt: "x", onerror: "run()", OnLoad: "run()" }, childNodes: [] },
        { type: 2, id: 2, tagName: "a", attributes: { href: " java\nscript:run()" }, childNodes: [] },
        { type: 2, id: 3, tagName: "iframe", attributes: { srcdoc: "<script>run()</script>" }, childNodes: [] },
      ] } } };
      const [img, a, frame] = rewrite([snapshot])[0].data.node.childNodes;
      expect(img.attributes).toEqual({ alt: "x" });
      expect(a.attributes).toEqual({});
      expect(frame.attributes).toEqual({});

      const change = { type: 3, data: { source: 0, adds: [{ node: { type: 2, id: 4, tagName: "b", attributes: { onclick: "run()" }, childNodes: [] } }],
        texts: [], attributes: [{ id: 1, attributes: { onerror: "run()" } }] } };
      const [changed] = rewrite([change]);
      expect(changed.data.adds[0].node.attributes).toEqual({});
      expect(changed.data.attributes[0].attributes).toEqual({});
    }
  });

  it("leaves resources alone without the proxy", () => {
    const snapshot = { type: 2, data: { node: { type: 0, childNodes: [
      { type: 2, id: 1, tagName: "img", attributes: { src: "https://a.com/x.png", style: "background: url(https://a.com/b.png)" }, childNodes: [] },
    ] } } };
    const [img] = createRewriter(null)([snapshot])[0].data.node.childNodes;
    expect(img.attributes).toEqual({ src: "https://a.com/x.png", style: "background: url(https://a.com/b.png)" });
  });

  it("checks resource messages", () => {
    expect(isBrowserMessage({ t: "res-need", id: 1, url: "https://a.com/x.png" })).toBe(true);
    expect(isBrowserMessage({ t: "res-need", id: 1, url: "file:///etc/passwd" })).toBe(false);
    expect(isBrowserMessage({ t: "res", id: 1, index: 0, total: 1, status: 200, type: "image/png", data: "AA==" })).toBe(true);
    expect(isBrowserMessage({ t: "res", id: 1, index: 1, total: 1, status: 200, type: "image/png", data: "" })).toBe(false);
  });
});
