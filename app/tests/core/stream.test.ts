import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// The desktop content bridge, in memory: parts by id, finished content by hash.
const stored = new Map<string, Uint8Array>();
vi.mock("../../src/core/desktop", () => {
  const parts = new Map<number, Uint8Array[]>();
  let next = 1;
  return {
    desktop: {
      content: {
        partOpen: async () => {
          parts.set(next, []);
          return { id: next++, size: 0 };
        },
        partAppend: async (id: number, bytes: Uint8Array) => {
          parts.get(id)!.push(new Uint8Array(bytes));
          return parts.get(id)!.reduce((n, b) => n + b.byteLength, 0);
        },
        partFinish: async (id: number) => {
          const whole = Buffer.concat(parts.get(id)!);
          parts.delete(id);
          const hash = createHash("sha256").update(whole).digest("hex");
          const existed = stored.has(hash);
          stored.set(hash, whole);
          return { hash, existed };
        },
        partClose: async (id: number) => {
          parts.delete(id);
        },
      },
    },
  };
});
vi.mock("../../src/core/content", () => ({ markPresent: () => {} }));

const { chunkSize, storeFile } = await import("../../src/core/stream");

describe("storeFile", () => {
  it("makes a big file's piece list while copying it in: the SHA-256 of each chunk", async () => {
    const bytes = randomBytes(2 * chunkSize + 5);
    const result = await storeFile(new Blob([bytes]), { pieceListFrom: chunkSize });
    expect(Buffer.from(stored.get(result.hash)!).equals(bytes)).toBe(true);
    const list = Buffer.from(stored.get(result.pieces!)!);
    const expected = Buffer.concat([0, 1, 2].map((i) => createHash("sha256").update(bytes.subarray(i * chunkSize, (i + 1) * chunkSize)).digest()));
    expect(list.equals(expected)).toBe(true);
  });

  it("makes none for smaller files, or without the option", async () => {
    expect((await storeFile(new Blob([randomBytes(1000)]), { pieceListFrom: chunkSize })).pieces).toBeUndefined();
    expect((await storeFile(new Blob([randomBytes(chunkSize + 1)]))).pieces).toBeUndefined();
  });
});
