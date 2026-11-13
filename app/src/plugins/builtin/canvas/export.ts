// Files made from an SVG (design layers, diagram pages): the SVG itself, drawn onto a canvas for PNG, JPG and WEBP,
// or a JPG inside a PDF.
import { zipSync } from "fflate";
import { saveBlob } from "../../../ui/download";

export type ExportFormat = "png" | "jpg" | "webp" | "svg" | "pdf";

// One file to make when exporting: its size factor, format and a name suffix ("" for automatic).
export interface ExportSetting {
  scale: number;
  format: ExportFormat;
  suffix: string;
}

export const exportFormats: { value: ExportFormat; label: string }[] = [
  { value: "png", label: "PNG" }, { value: "jpg", label: "JPG" }, { value: "webp", label: "WEBP" },
  { value: "svg", label: "SVG" }, { value: "pdf", label: "PDF" },
];
export const exportScales = [0.5, 0.75, 1, 1.5, 2, 3, 4];

const num = (v: number) => String(Math.round(v * 1000) / 1000);

export async function rasterSvg(svg: string, scale: number, type: "image/png" | "image/jpeg" | "image/webp"): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't draw the export.");
    if (type === "image/jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't draw the export."))), type, 0.92));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// A one-page PDF showing a JPG, sized to the layer (1 px = 0.75 pt, so it prints at its size on screen).
async function pdf(jpg: Blob, pixelsWide: number, pixelsHigh: number, width: number, height: number): Promise<Blob> {
  const data = new Uint8Array(await jpg.arrayBuffer());
  const w = num(width * 0.75);
  const h = num(height * 0.75);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  const parts: (string | Uint8Array)[] = [];
  const offsets: number[] = [];
  let length = 0;
  const add = (part: string | Uint8Array) => {
    parts.push(part);
    length += typeof part === "string" ? new TextEncoder().encode(part).length : part.length;
  };
  const object = (body: () => void) => {
    offsets.push(length);
    add(`${offsets.length} 0 obj\n`);
    body();
    add("\nendobj\n");
  };
  add("%PDF-1.4\n");
  object(() => add("<< /Type /Catalog /Pages 2 0 R >>"));
  object(() => add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  object(() => add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  object(() => {
    add(`<< /Type /XObject /Subtype /Image /Width ${pixelsWide} /Height ${pixelsHigh} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n`);
    add(data);
    add("\nendstream");
  });
  object(() => add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  const xref = length;
  add(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  add(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

// `width` and `height`: the SVG's size in px at scale 1.
export async function svgFile(svg: string, width: number, height: number, baseName: string, setting: ExportSetting): Promise<{ name: string; blob: Blob }> {
  const suffix = setting.suffix || (setting.scale !== 1 && setting.format !== "svg" ? `@${setting.scale}x` : "");
  const name = `${baseName}${suffix}.${setting.format}`;
  if (setting.format === "svg") return { name, blob: new Blob([svg], { type: "image/svg+xml" }) };
  if (setting.format === "pdf") {
    const jpg = await rasterSvg(svg, setting.scale, "image/jpeg");
    return { name, blob: await pdf(jpg, Math.max(1, Math.round(width * setting.scale)), Math.max(1, Math.round(height * setting.scale)), width, height) };
  }
  const type = setting.format === "png" ? "image/png" : setting.format === "jpg" ? "image/jpeg" : "image/webp";
  return { name, blob: await rasterSvg(svg, setting.scale, type) };
}

const safe = (name: string) => name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").trim() || "Export";

// One file is saved as it is, several go into `<zipName>.zip`.
export async function saveExports(files: { name: string; blob: Blob }[], zipName: string): Promise<void> {
  if (files.length === 0) return;
  if (files.length === 1) return saveBlob(files[0].blob, safe(files[0].name));
  const used = new Set<string>();
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    let name = safe(f.name);
    const dot = name.lastIndexOf(".");
    for (let i = 2; used.has(name); i++) name = `${f.name.slice(0, dot)} (${i})${f.name.slice(dot)}`;
    used.add(name);
    entries[name] = new Uint8Array(await f.blob.arrayBuffer());
  }
  saveBlob(new Blob([zipSync(entries, { level: 0 }) as BlobPart], { type: "application/zip" }), safe(`${zipName}.zip`));
}
