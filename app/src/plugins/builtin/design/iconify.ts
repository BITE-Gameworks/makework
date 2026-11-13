// Icons from Iconify (api.iconify.design). Icon data comes in one request per icon set (`/<set>.json?icons=...`),
// never one per icon: a search shows dozens, and per-icon requests run into the API's rate limit. Kept for the
// session, so searching again or inserting costs nothing.
const api = "https://api.iconify.design";
const cache = new Map<string, string>();

export interface IconSet {
  name: string;
  license: string;
  licenseUrl: string;
}

export async function searchIcons(query: string, prefix: string, limit: number): Promise<{ icons: string[]; sets: Record<string, IconSet> }> {
  const params = new URLSearchParams({ query, limit: String(limit) });
  if (prefix) params.set("prefix", prefix);
  const response = await fetch(`${api}/search?${params}`);
  if (!response.ok) throw new Error(`Search failed (${response.status}).`);
  const found = (await response.json()) as {
    icons?: string[];
    collections?: Record<string, { name?: string; license?: { title?: string; url?: string } }>;
  };
  const sets = Object.fromEntries(Object.entries(found.collections ?? {}).map(([id, c]) => [id, {
    name: c.name ?? id, license: c.license?.title ?? "See iconify.design", licenseUrl: c.license?.url ?? `https://icon-sets.iconify.design/${id}/`,
  }]));
  return { icons: found.icons ?? [], sets };
}

// SVG markup for icons by Iconify name ("set:name"); those that can't be loaded are left out.
export async function loadIcons(names: string[]): Promise<Map<string, string>> {
  const missing = new Map<string, string[]>();
  for (const name of names) {
    if (cache.has(name)) continue;
    const [set, icon] = name.split(":");
    if (set && icon) missing.set(set, [...(missing.get(set) ?? []), icon]);
  }
  const sets = [...missing];
  // A few sets at a time.
  for (let i = 0; i < sets.length; i += 6) {
    await Promise.all(sets.slice(i, i + 6).map(async ([set, icons]) => {
      const response = await fetch(`${api}/${encodeURIComponent(set)}.json?icons=${icons.map(encodeURIComponent).join(",")}`);
      if (!response.ok) return;
      const data = (await response.json()) as {
        width?: number; height?: number; left?: number; top?: number;
        icons?: Record<string, { body: string; width?: number; height?: number; left?: number; top?: number }>;
        aliases?: Record<string, { parent: string }>;
      };
      const entries = { ...data.icons };
      for (const [alias, { parent }] of Object.entries(data.aliases ?? {})) if (entries[parent]) entries[alias] = entries[parent];
      for (const [icon, d] of Object.entries(entries)) {
        const box = [d.left ?? data.left ?? 0, d.top ?? data.top ?? 0, d.width ?? data.width ?? 16, d.height ?? data.height ?? 16];
        cache.set(`${set}:${icon}`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.join(" ")}">${d.body}</svg>`);
      }
    }));
  }
  return new Map(names.filter((n) => cache.has(n)).map((n) => [n, cache.get(n)!]));
}

export async function fetchIcon(name: string): Promise<string> {
  const svg = (await loadIcons([name])).get(name);
  if (!svg) throw new Error(`Icon ${name} couldn't be loaded.`);
  return svg;
}
