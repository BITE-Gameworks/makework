// Types for electron/webLookup.js, which the main process runs as plain JavaScript.
export function isPublicAddress(address: string): boolean;
export function publicUrl(text: string): Promise<URL | null>;
export function htmlToText(html: string): string;
export function parseSearchResults(html: string): { title: string; url: string; snippet: string }[];
export function parseBingResults(html: string): { title: string; url: string; snippet: string }[];
export function createLookup(options: {
  fetch: (url: string, init: Record<string, unknown>) => Promise<Response>;
  searchFetch?: (url: string, init: Record<string, unknown>) => Promise<Response>;
  resolve?: (host: string) => Promise<{ address: string }[]>;
}): {
  read(address: string): Promise<{ url: string; text: string; truncated: boolean }>;
  search(query: string): Promise<{ title: string; url: string; snippet: string }[]>;
};
export function publicUrl(text: string): Promise<URL | null>;
export function followPublic(
  fetch: (address: string, init: RequestInit) => Promise<Response>, address: string, init?: RequestInit, maxHops?: number,
): Promise<Response>;
export function connectPublic(address: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>;
