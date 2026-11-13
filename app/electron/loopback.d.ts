// Types for electron/loopback.js, which the main process runs as plain JavaScript.
export function loopbackOnce(options: {
  path: string;
  accept: (url: URL) => boolean;
  page: (url: URL) => { ok: boolean; title: string; message: string };
  open: (base: string, port: number) => void;
  timeoutMs: number;
}): { promise: Promise<URL>; cancel: () => void };
