// Puts an image on the clipboard. Browsers only take PNG there, so other formats are redrawn first.
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("No picture."))), "image/png"));
}

export async function copyImage(source: Blob | Promise<Blob>): Promise<void> {
  const png = Promise.resolve(source).then(asPng);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export const copyImageFrom = (url: string) => copyImage(fetch(url).then((r) => r.blob()));
