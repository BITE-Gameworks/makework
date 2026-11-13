// Pictures for the model: shrunk first, because a vision model reads a picture as a number of tokens that grows with its
// size, and a small context (a few thousand tokens) fills quickly. Runs in the app (canvas), not in a node.
import { contentBlob } from "../core/content";

export const defaultImageSide = 512;

const readAsDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error("The picture could not be read."));
  reader.readAsDataURL(blob);
});

// A JPEG data URL of the picture, longest side at most `maxSide`. Uses the small preview when the full picture isn't
// on this device.
export async function imageForModel(url: string, mime: string, thumb: string | null, maxSide = defaultImageSide): Promise<string> {
  let blob: Blob;
  try {
    blob = await contentBlob(url, mime || "image/png");
  } catch (e) {
    if (!thumb?.startsWith("data:image/")) throw e;
    blob = await (await fetch(thumb)).blob();
  }
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, Math.max(64, maxSide) / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
  const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) throw new Error("Pictures can't be prepared here.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const out = canvas instanceof OffscreenCanvas
    ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 })
    : await new Promise<Blob>((resolve, reject) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error("The picture could not be shrunk."))), "image/jpeg", 0.85));
  return readAsDataUrl(out);
}
