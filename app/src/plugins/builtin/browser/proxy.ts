// The resource proxy's side in the mirror: images and stylesheet resources in the host's recorded DOM are asked for
// through mwbrowser://<token>/<base64url> (electron/sharedBrowser.js), which loads them over this member's own
// connection, else from the host's copy of the page.
import { trimEnd } from "../../../core/text";

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// DOM batches go gzipped and in base64: a page's snapshot is mostly markup and CSS, about a tenth of its size packed.
export async function packDom(events: unknown[]): Promise<string> {
  const stream = new Blob([JSON.stringify(events)]).stream().pipeThrough(new CompressionStream("gzip"));
  return toBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export async function unpackDom(text: string): Promise<unknown> {
  const stream = new Blob([fromBase64(text)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

export const proxyUrl = (token: string, url: string) =>
  `mwbrowser://${token}/${trimEnd(toBase64(encoder.encode(url)).replaceAll("+", "-").replaceAll("/", "_"), "=")}`;

const web = /^https?:\/\//i;
const cssUrl = /url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/gi;
const srcsetUrl = /(^|,\s*)(https?:\/\/[^\s,]+)/gi;

// Attributes that load a resource, by tag; `style` and rrweb's inlined `_cssText` are rewritten on any element.
const resourceAttributes: Record<string, string[]> = {
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  input: ["src"],
  video: ["poster"],
  image: ["href", "xlink:href"],
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type SerializedNode = { type: number; id?: number; tagName?: string; attributes?: Record<string, Json>; childNodes?: SerializedNode[];
  textContent?: string; isStyle?: boolean };

// rrweb event and source numbers used here.
const fullSnapshot = 2;
const incremental = 3;
const mutation = 0;
const styleSheetRule = 8;
const styleDeclaration = 13;
const adoptedStyleSheet = 15;

// What a recorded page or its host could use to run script in the mirror.
const isScriptUrl = (v: string) => /^javascript:/i.test(v.replace(/[\u0000- ]/g, ""));
const runsScript = (name: string, v: Json) =>
  /^on/i.test(name) || name.toLowerCase() === "srcdoc" || (typeof v === "string" && isScriptUrl(v));

// Prepares what a host sent for the mirror: anything that could run script goes, and with a `token` resources load
// through the proxy.
export function createRewriter(token: string | null) {
  const tags = new Map<number, string>();
  const css = (text: string) => (token === null ? text
    : text.replace(cssUrl, (_all, quote: string, url: string) => `url(${quote}${proxyUrl(token, url)}${quote})`));
  const value = (tag: string | undefined, name: string, v: Json): Json => {
    if (token === null || typeof v !== "string") return v;
    if (name === "style" || name === "_cssText") return css(v);
    if (!tag || !resourceAttributes[tag]?.includes(name)) return v;
    if (name === "srcset") return v.replace(srcsetUrl, (_all, lead: string, url: string) => `${lead}${proxyUrl(token, url)}`);
    return web.test(v) ? proxyUrl(token, v) : v;
  };
  const attributes = (tag: string | undefined, list: Record<string, Json>) => {
    for (const [name, v] of Object.entries(list)) {
      if (runsScript(name, v)) delete list[name];
      else if (name === "style" && v && typeof v === "object" && !Array.isArray(v)) {
        // A style change as properties: { prop: value | [value, priority] | false }.
        for (const [prop, part] of Object.entries(v)) {
          if (typeof part === "string") v[prop] = css(part);
          else if (Array.isArray(part) && typeof part[0] === "string") part[0] = css(part[0]);
        }
      } else {
        list[name] = value(tag, name, v);
      }
    }
  };
  const node = (n: SerializedNode) => {
    if (n.type === 2 && n.tagName) {
      if (n.id !== undefined) tags.set(n.id, n.tagName.toLowerCase());
      if (n.attributes) attributes(n.tagName.toLowerCase(), n.attributes);
    } else if (n.type === 3 && n.isStyle && typeof n.textContent === "string") {
      n.textContent = css(n.textContent);
    }
    n.childNodes?.forEach(node);
  };
  const rules = (list: unknown) => {
    if (Array.isArray(list)) for (const add of list) if (add && typeof add.rule === "string") add.rule = css(add.rule);
  };

  // Rewrites rrweb events in place and returns them.
  return <T>(events: T[]): T[] => {
    for (const event of events as { type: number; data: Record<string, unknown> }[]) {
      const data = event.data;
      if (!data) continue;
      if (event.type === fullSnapshot) {
        tags.clear();
        node(data.node as SerializedNode);
      } else if (event.type === incremental && data.source === mutation) {
        for (const add of (data.adds ?? []) as { node: SerializedNode }[]) node(add.node);
        for (const change of (data.attributes ?? []) as { id: number; attributes: Record<string, Json> }[]) attributes(tags.get(change.id), change.attributes);
        for (const text of (data.texts ?? []) as { value: string | null }[]) if (typeof text.value === "string") text.value = css(text.value);
      } else if (event.type === incremental && data.source === styleSheetRule) {
        rules(data.adds);
        if (typeof data.replace === "string") data.replace = css(data.replace);
        if (typeof data.replaceSync === "string") data.replaceSync = css(data.replaceSync);
      } else if (event.type === incremental && data.source === styleDeclaration) {
        const set = data.set as { value?: unknown } | undefined;
        if (set && typeof set.value === "string") set.value = css(set.value);
      } else if (event.type === incremental && data.source === adoptedStyleSheet) {
        for (const style of (data.styles ?? []) as { rules: unknown }[]) rules(style.rules);
      }
    }
    return events;
  };
}
