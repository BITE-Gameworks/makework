import { describe, expect, it } from "vitest";
import { identiconPath, randomSeed } from "../../src/ui/identicon";

const cells = (path: string) => [...path.matchAll(/M(\d) (\d)/g)].map(([, x, y]) => `${x},${y}`);

describe("identicon", () => {
  it("is the same for a seed and mirrored left to right", () => {
    const seed = randomSeed();
    expect(identiconPath(seed)).toBe(identiconPath(seed));
    const on = new Set(cells(identiconPath(seed)));
    for (const cell of on) {
      const [x, y] = cell.split(",").map(Number);
      expect(on.has(`${4 - x},${y}`)).toBe(true);
    }
  });

  it("differs between seeds", () => {
    expect(identiconPath("alice")).not.toBe(identiconPath("bob"));
  });
});
