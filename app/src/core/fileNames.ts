import { trimEnd } from "./text";

// The same rules as electron/files.js safeSegment: a name every file system accepts (Windows is the strictest:
// no \/:*?"<>|, no device names like CON or nul.txt, no trailing dots or spaces).
export function safeName(name: string): string {
  let cleaned = trimEnd(name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 200), ". ");
  if (cleaned === "") return "_";
  const device = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.exec(cleaned);
  if (device) cleaned = `${device[1]}_${device[2] ?? ""}`;
  return cleaned;
}

// "photo.png", "conflict" -> "photo (conflict).png"
export function suffixedName(name: string, suffix: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${suffix})${name.slice(dot)}` : `${name} (${suffix})`;
}

// "photo.png", 2 -> "photo (2).png"
export const numberedName = (name: string, n: number): string => suffixedName(name, String(n));

const mimeExtensions: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg",
  "image/avif": ".avif", "image/bmp": ".bmp", "application/pdf": ".pdf", "video/mp4": ".mp4", "video/webm": ".webm",
  "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav",
};

const extensionMimes: Record<string, string> = {
  ...Object.fromEntries(Object.entries(mimeExtensions).map(([mime, ext]) => [ext, mime])),
  ".jpeg": "image/jpeg", ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".zip": "application/zip",
  ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".flac": "audio/flac", ".m4a": "audio/mp4", ".csv": "text/csv",
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".ts": "text/plain", ".psd": "image/vnd.adobe.photoshop",
  ".blend": "application/x-blender", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".fbx": "application/octet-stream",
};

// A media type for a file name, by its extension.
export function mimeOfName(name: string): string {
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0].toLowerCase() ?? "";
  return extensionMimes[ext] ?? "application/octet-stream";
}

// A name with an extension: kept when it has one, else the given one added ("photo", ".png" -> "photo.png").
export function withExtension(name: string, extension: string): string {
  return !extension || /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : `${name}${extension}`;
}

// The extension a file's first bytes show (images and PDF), or "".
export function sniffExtension(head: Uint8Array): string {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  const text = new TextDecoder().decode(head.slice(0, 64)).trimStart().toLowerCase();
  if (starts(0x89, 0x50, 0x4e, 0x47)) return ".png";
  if (starts(0xff, 0xd8, 0xff)) return ".jpg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return ".gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCodePoint(...head.slice(8, 12)) === "WEBP") return ".webp";
  if (String.fromCodePoint(...head.slice(4, 12)) === "ftypavif") return ".avif";
  if (starts(0x25, 0x50, 0x44, 0x46)) return ".pdf";
  if (starts(0x42, 0x4d)) return ".bmp";
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return ".svg";
  return "";
}
