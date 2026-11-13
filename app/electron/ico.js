// Windows .ico files from PNG images (Windows reads PNG entries at every size since Vista): the themed icon of our
// Start Menu shortcut (windowsShortcut.js) and the dev executable's icon (dev.js).

// `images`: [{ size, png }], each a square PNG `size` pixels wide (256 and above are stored as 0, meaning 256).
export function icoFromPngs(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1: icon (2 would be a cursor)
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    const side = size >= 256 ? 0 : size;
    header.writeUInt8(side, at);
    header.writeUInt8(side, at + 1);
    header.writeUInt16LE(1, at + 4); // color planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}
