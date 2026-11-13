// Types for electron/mediaSource.js, which the main process runs as plain JavaScript.
export interface ResolvedMedia {
  session: string; title: string; duration: number | null; live: boolean; picture: string | null; sound: string | null;
}
export interface MediaFormat { url: string; vcodec?: string | null; acodec?: string | null; http_headers?: Record<string, string> }
export function pickStreams(info: Record<string, unknown>, wantPicture: boolean): { picture: MediaFormat | null; sound: MediaFormat | null; combined: boolean };
export function ytDlpBuild(platform: string, arch: string): string | null;
export function createMediaSource(deps: {
  spawn: (...args: never[]) => unknown; fetch: (url: string, init?: RequestInit) => Promise<Response>;
  toolDir?: string | null; platform?: string; arch?: string; runtime?: { path: string; env?: Record<string, string> } | null;
}): { resolve(address: string, audioOnly: boolean): Promise<ResolvedMedia>; list(address: string): Promise<{ url: string; title: string; duration: number | null }[]>; release(session: string): void; proxy(request: Request): Promise<Response> };
