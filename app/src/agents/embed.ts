// Optional meaning-based search for the workspace index: a small embedding model on any OpenAI-compatible server
// (llama.cpp with --embedding), named by the agent's "Embedding server" setting. Vectors are kept in memory on this
// device only and made again when an entry changes. Without the setting the index uses keywords and tags alone.
import type { LibraryEntry } from "../plugins/types";
import type { LlmServer } from "../core/llm";
import { trimEnd } from "../core/text";

const batch = 32;
const maxEntries = 800;
const cache = new Map<string, number[]>();

async function embed(server: LlmServer, inputs: string[]): Promise<number[][]> {
  const base = trimEnd(server.baseUrl.trim(), "/").replace(/\/v1$/, "");
  const response = await fetch(`${base}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}) },
    body: JSON.stringify({ input: inputs, ...(server.model ? { model: server.model } : {}) }),
  });
  if (!response.ok) throw new Error(`The embedding server answered ${response.status}.`);
  const data = await response.json();
  const rows: { embedding?: number[]; index?: number }[] = Array.isArray(data?.data) ? data.data : [];
  if (rows.length !== inputs.length) throw new Error("The embedding server sent the wrong number of vectors.");
  return rows.toSorted((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((r) => r.embedding ?? []);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const textOf = (e: LibraryEntry) => `${e.title}. ${e.summary} ${e.tags.join(" ")}`;
const keyOf = (e: LibraryEntry) => `${e.ref}|${textOf(e)}`;

// How close each entry is to the query (0 to 1), for the newest entries up to a limit. Empty when the server fails.
export async function similarities(server: LlmServer, entries: LibraryEntry[], query: string): Promise<Map<LibraryEntry, number>> {
  const result = new Map<LibraryEntry, number>();
  try {
    const some = entries.slice(-maxEntries);
    const missing = some.filter((e) => !cache.has(keyOf(e)));
    for (let i = 0; i < missing.length; i += batch) {
      const part = missing.slice(i, i + batch);
      (await embed(server, part.map(textOf))).forEach((vector, j) => cache.set(keyOf(part[j]), vector));
    }
    const [q] = await embed(server, [query]);
    for (const e of some) result.set(e, Math.max(0, cosine(q, cache.get(keyOf(e)) ?? [])));
  } catch { /* keywords only */ }
  return result;
}
