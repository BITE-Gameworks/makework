import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { connectPublic, createLookup, followPublic, htmlToText, isPublicAddress, parseBingResults, parseSearchResults } from "../../electron/webLookup.js";

const page = (body: string, status = 200, headers: Record<string, string> = { "content-type": "text/html" }) =>
  new Response(body, { status, headers });

describe("isPublicAddress", () => {
  it("refuses other spellings and tunnels of private addresses", () => {
    for (const a of ["::ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:c0a8:1", "::7f00:1", "64:ff9b::7f00:1",
      "2002:7f00:1::", "2001:0:1::", "2001:db8::1", "fe80::1", "fec0::1", "ff02::1", "::", "192.0.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "not an ip"])
      expect(isPublicAddress(a), a).toBe(false);
    for (const a of ["::ffff:808:808", "2a00:1450::1", "2001:4860:4860::8888", "198.18.0.1", "64:ff9b::808:808", "64:ff9b:1::808:808"]) expect(isPublicAddress(a), a).toBe(true);
  });

  it("refuses a name that leads to this machine when connecting", async () => {
    const server = createServer((_request, response) => response.end("private"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await expect(connectPublic(`http://localhost:${port}/`)).rejects.toThrow("not a public website");
    server.close();
  });

  it("follows no redirect into a private network", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://[::ffff:127.0.0.1]/" } }));
    expect((await followPublic(fetch, "http://8.8.8.8/")).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses this machine and private networks", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.0.1", "169.254.1.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPublicAddress(a)).toBe(false);
    for (const a of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) expect(isPublicAddress(a)).toBe(true);
  });
  it("sees the IPv4 address inside IPv6 forms", () => {
    // Written the way URL writes them ([::ffff:127.0.0.1] becomes [::ffff:7f00:1]), with or without brackets.
    for (const a of [
      "::ffff:7f00:1", "[::ffff:7f00:1]", "::ffff:a00:1", "::ffff:c0a8:1", "::7f00:1", "::127.0.0.1", "0:0:0:0:0:ffff:7f00:1",
      "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "2002:7f00:1::", "2002:c0a8:101::1", "2001:0:4136:e378:8000:63bf:80ff:fffe",
      "ff02::1", "fec0::1", "64:ff9b:1::1", "::", "[::1]",
    ]) expect(isPublicAddress(a), a).toBe(false);
    for (const a of ["::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1", "[2606:4700::1111]", "2a00:1450:4001:80b::200e"])
      expect(isPublicAddress(a), a).toBe(true);
  });
});

describe("text and results", () => {
  it("turns a page into plain text without scripts", () => {
    expect(htmlToText("<head><title>x</title></head><body><script>bad()</script><h1>Hi &amp; bye</h1><p>One</p><p>Two</p></body>")).toBe("Hi & bye\nOne\nTwo");
  });
  it("reads search results and unwraps redirects", () => {
    const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Title <b>A</b></a><a class="result__snippet" href="x">Snippet A</a>';
    expect(parseSearchResults(html)).toEqual([{ title: "Title A", url: "https://example.com/a", snippet: "Snippet A" }]);
  });
});

describe("lookup", () => {
  const resolve = async (host: string) => [{ address: host === "intranet.test" ? "10.0.0.5" : "93.184.216.34" }];
  it("reads a public page, and refuses private hosts, odd schemes and redirects into them", async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      if (url.includes("redirect")) return new Response(null, { status: 302, headers: { location: "http://intranet.test/secret" } });
      return page("<p>Hello world</p>");
    };
    const lookup = createLookup({ fetch, resolve });
    expect(await lookup.read("https://example.com/")).toEqual({ url: "https://example.com/", text: "Hello world", truncated: false });
    await expect(lookup.read("http://127.0.0.1:8080/")).rejects.toThrow(/not a public website/);
    await expect(lookup.read("http://intranet.test/")).rejects.toThrow(/not a public website/);
    await expect(lookup.read("file:///etc/passwd")).rejects.toThrow(/Only http/);
    await expect(lookup.read("https://example.com/redirect")).rejects.toThrow(/not a public website/);
    expect(calls).not.toContain("http://intranet.test/secret");
  });
  it("refuses binary content", async () => {
    const lookup = createLookup({ fetch: async () => page("x", 200, { "content-type": "application/zip" }), resolve });
    await expect(lookup.read("https://example.com/a.zip")).rejects.toThrow(/not a text page/);
  });
});

describe("parseBingResults", () => {
  it("reads the address wrapped in a Bing link", () => {
    const wrapped = Buffer.from("https://example.com/a").toString("base64").replace(/=+$/, "");
    const html = `<li class="b_algo"><h2><a target="_blank" href="https://www.bing.com/ck/a?x=1&amp;u=a1${wrapped}&amp;ntb=1">Title A</a></h2><p>Snippet A</p></li>`;
    expect(parseBingResults(html)).toEqual([{ title: "Title A", url: "https://example.com/a", snippet: "Snippet A" }]);
  });
});
