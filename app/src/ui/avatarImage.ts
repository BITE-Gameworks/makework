// Turns a picked image into a small square avatar: cropped to the middle, 128px, as a data URL that fits in a profile row.
const size = 128;
const maxLength = 48_000;

export async function avatarFromFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file isn't an image this app can read.");
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  // WebKit can't encode WebP and falls back to PNG; JPEG keeps big photos small.
  for (const [type, quality] of [["image/webp", 0.85], ["image/jpeg", 0.85], ["image/jpeg", 0.6]] as const) {
    const url = canvas.toDataURL(type, quality);
    if (url.startsWith(`data:${type}`) && url.length <= maxLength) return url;
  }
  throw new Error("That image is too detailed to use as an avatar.");
}
