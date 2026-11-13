import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileContent } from "../../src/node/storage";

const dirs: string[] = [];
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "mw-node-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i % 251)) as Uint8Array<ArrayBuffer>;
const hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

describe("node content store", () => {
  it("resumes a download after a restart and keeps it only when the hash matches", async () => {
    const dir = await scratch();
    const data = bytes(10_000);
    const hash = hex(data);
    const first = await fileContent(dir).openWriter(hash);
    await first.append(data.subarray(0, 4000) as Uint8Array<ArrayBuffer>);
    await first.close(false);

    const store = fileContent(dir);
    const second = await store.openWriter(hash);
    expect(second.size).toBe(4000);
    await second.append(data.subarray(4000) as Uint8Array<ArrayBuffer>);
    expect(await second.finish(hash)).toEqual({ hash, existed: false });
    expect(await store.size(hash)).toBe(10_000);
    expect(await store.readRange(hash, 9990, 20_000)).toEqual(data.subarray(9990));
    expect(new Uint8Array(await readFile(join(dir, "content", hash)))).toEqual(data);

    const wrong = await store.openWriter("0".repeat(64));
    await wrong.append(data);
    await expect(wrong.finish("0".repeat(64))).rejects.toThrow(/doesn't match/);
    expect(await store.has("0".repeat(64))).toBe(false);
  });

  it("refuses paths that aren't content hashes", async () => {
    const store = fileContent(await scratch());
    await expect(store.openWriter("../../etc/passwd")).rejects.toThrow(/Not a content hash/);
  });
});
