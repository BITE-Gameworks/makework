// Web lookups for agents: a search and a page reader that give back plain text. Only public http(s) hosts are fetched
// (never the user's own network), redirects are followed by hand and checked each time, and the answer is cut small.
import { lookup as dnsLookupCallback } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

const maxBytes = 1_500_000;
const maxChars = 6000;
const maxRedirects = 4;
const timeoutMs = 12_000;

// An IPv6 address as its eight 16-bit groups. Valid input only (`isIP`).
function ipv6Groups(address) {
  let text = address.toLowerCase().split("%")[0];
  // An IPv4 tail ("::ffff:1.2.3.4") counts as the last two groups.
  const last = text.slice(text.lastIndexOf(":") + 1);
  const dotted = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(last);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, text.length - last.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const groups = (part) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  if (tail === undefined) return groups(head);
  const [start, end] = [groups(head), groups(tail)];
  return [...start, ...new Array(8 - start.length - end.length).fill(0), ...end];
}

// Addresses that lead into a private network or this machine, or aren't for the public internet at all. 198.18.0.0/15
// counts as public: proxies in fake-IP mode (Clash, sing-box, Surge) answer every name from it.
export function isPublicAddress(written) {
  const address = String(written).replace(/^\[|\]$/g, "");
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const g = ipv6Groups(address);
    const embedded = () => isPublicAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff) return embedded();
    // NAT64: how an IPv6-only network reaches IPv4 sites.
    if (g[0] === 0x64 && g[1] === 0xff9b) return embedded();
    if (g[0] === 0x2002) return isPublicAddress(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`);
    // Only global unicast, without Teredo (tunnels to any IPv4 address) or documentation.
    return (g[0] & 0xe000) === 0x2000 && !(g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8));
  }
  return false;
}

export async function publicUrl(text) {
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  try {
    const addresses = isIP(host) ? [{ address: host }] : await dnsLookup(host, { all: true });
    if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) return null;
  } catch {
    return null;
  }
  return url;
}

// `fetch` with redirects followed by hand, each one checked; a Response either way.
export async function followPublic(fetch, address, init = {}, maxHops = 4) {
  let target = address;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!(await publicUrl(target))) return new Response("Blocked", { status: 403 });
    let upstream;
    try {
      upstream = await fetch(target, { ...init, redirect: "manual" });
    } catch {
      return new Response("Unreachable", { status: 502 });
    }
    const next = upstream.status >= 300 && upstream.status < 400 ? upstream.headers.get("location") : null;
    if (!next) return upstream;
    await upstream.body?.cancel();
    target = new URL(next, target).toString();
  }
  return new Response("Too many redirects", { status: 502 });
}

function publicLookup(host, options, callback) {
  dnsLookupCallback(host, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) return callback(new Error("That address is not a public website."));
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

const noBody = new Set([101, 204, 205, 304]);

// One request that checks the addresses as it connects, so a name can't turn private after an earlier check. Node's own
// connection, since Chromium's (net.fetch) can't take a lookup. Redirects are the caller's.
export function connectPublic(address, { headers, signal } = {}) {
  const { request } = address.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const outgoing = request(address, { headers, signal, lookup: publicLookup }, (incoming) => {
      const answer = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) answer.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      const empty = noBody.has(incoming.statusCode);
      if (empty) incoming.resume();
      resolve(new Response(empty ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers: answer }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h\d|tr|br|section|article)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^<>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => entities[m] ?? m)
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Results of DuckDuckGo's plain page: title, address and snippet.
export function parseSearchResults(html) {
  const results = [];
  const blocks = String(html).split(/class="result__a"/).slice(1);
  for (const block of blocks) {
    const link = /href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    let url = link[1].replaceAll("&amp;", "&");
    const wrapped = /[?&]uddg=([^&]+)/.exec(url);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    if (url.startsWith("//")) url = `https:${url}`;
    if (!/^https?:\/\//.test(url)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    results.push({ title: htmlToText(link[2]), url, snippet: snippet ? htmlToText(snippet[1]) : "" });
    if (results.length >= 8) break;
  }
  return results;
}

// Results of Bing's page (the fallback when DuckDuckGo asks for a challenge): its links wrap the address in base64.
export function parseBingResults(html) {
  const results = [];
  for (const block of String(html).split(/<li class="b_algo"/).slice(1)) {
    const link = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    let url = link[1].replaceAll("&amp;", "&");
    const wrapped = /[?&]u=a1([^&]+)/.exec(url);
    if (wrapped) {
      try { url = Buffer.from(wrapped[1].replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"); } catch { continue; }
    }
    if (!/^https?:\/\//.test(url)) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    results.push({ title: htmlToText(link[2]), url, snippet: snippet ? htmlToText(snippet[1]) : "" });
    if (results.length >= 8) break;
  }
  return results;
}

// `fetch` reads what agents ask for; `searchFetch` (default the same) asks the search engines, whose addresses are fixed.
export function createLookup({ fetch, searchFetch = fetch, resolve = (host) => dnsLookup(host, { all: true }) }) {
  async function checkUrl(text) {
    let url;
    try { url = new URL(text); } catch { throw new Error("That is not a web address."); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https addresses can be opened.");
    if (url.username || url.password) throw new Error("Addresses with a login are not opened.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host }] : await resolve(host).catch(() => []);
    if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) throw new Error("That address is not a public website.");
    return url;
  }

  async function get(text, request = fetch) {
    let url = await checkUrl(text);
    for (let hops = 0; hops <= maxRedirects; hops++) {
      const response = await request(url.toString(), {
        redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MakeWorkBot/1.0)", Accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        url = await checkUrl(new URL(response.headers.get("location"), url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`The site answered ${response.status}.`);
      const type = response.headers.get("content-type") ?? "";
      if (type && !/^(text\/|application\/(xhtml|json|xml))/i.test(type)) throw new Error(`That is not a text page (${type.split(";")[0]}).`);
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (size < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
      await reader.cancel().catch(() => {});
      return { url: url.toString(), type, body: new TextDecoder().decode(Buffer.concat(chunks)) };
    }
    throw new Error("Too many redirects.");
  }

  return {
    async read(address) {
      const page = await get(address);
      const text = /html|xml/i.test(page.type) || /^\s*</.test(page.body) ? htmlToText(page.body) : page.body;
      return { url: page.url, text: text.slice(0, maxChars), truncated: text.length > maxChars };
    },
    async search(query) {
      const text = String(query).trim().slice(0, 200);
      if (!text) throw new Error("Give something to search for.");
      const found = parseSearchResults((await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(text)}`, searchFetch).catch(() => ({ body: "" }))).body);
      if (found.length) return found;
      return parseBingResults((await get(`https://www.bing.com/search?q=${encodeURIComponent(text)}`, searchFetch)).body);
    },
  };
}
