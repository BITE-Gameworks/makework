import fs from "node:fs";
import path from "node:path";
import * as ResEdit from "resedit";
import { describe, expect, it } from "vitest";
import { icoFromPngs } from "../../electron/ico.js";

const icon = (size: number) => fs.readFileSync(path.join(__dirname, "../../resources/icons", `${size}x${size}.png`));

describe("icoFromPngs", () => {
  it("lists every PNG with its size and where its bytes are", () => {
    const images = [16, 48, 256].map((size) => ({ size, png: icon(size) }));
    const ico = icoFromPngs(images);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    images.forEach(({ size, png }, i) => {
      const at = 6 + 16 * i;
      expect(ico.readUInt8(at)).toBe(size === 256 ? 0 : size);
      expect(ico.readUInt8(at + 1)).toBe(size === 256 ? 0 : size);
      expect(ico.readUInt16LE(at + 6)).toBe(32);
      const length = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      expect(ico.subarray(offset, offset + length).equals(png)).toBe(true);
    });
    expect(ico).toHaveLength(6 + 16 * 3 + images.reduce((sum, { png }) => sum + png.length, 0));
  });

  it("reads back as an icon file with the same sizes (what dev.js puts into the executable)", () => {
    const sizes = [16, 32, 256];
    const file = ResEdit.Data.IconFile.from(icoFromPngs(sizes.map((size) => ({ size, png: icon(size) }))));
    // As stored: 0 stands for 256.
    expect(file.icons.map((item) => item.width || 256)).toEqual(sizes);
    expect(file.icons.map((item) => item.bitCount)).toEqual([32, 32, 32]);
  });
});
