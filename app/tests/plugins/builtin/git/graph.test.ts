import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphCommit } from "../../../../src/plugins/builtin/git/graph";

// "e:d c" = commit e with parents d and c; newest first.
const commits = (...specs: string[]): GraphCommit[] =>
  specs.map((s) => {
    const [sha, parents = ""] = s.split(":");
    return { sha, parents: parents.split(" ").filter(Boolean) };
  });
const lanes = (rows: ReturnType<typeof layoutGraph>["rows"]) => rows.map((r) => r.lane);
const lines = (row: ReturnType<typeof layoutGraph>["rows"][number], part: "top" | "bottom") =>
  row.lines.filter((l) => l.part === part).map((l) => `${l.from}>${l.to}${l.fade ? "~" : ""}`).sort();

describe("commit graph layout", () => {
  it("keeps a straight history in one lane", () => {
    const { rows, width } = layoutGraph(commits("c:b", "b:a", "a"));
    expect(lanes(rows)).toEqual([0, 0, 0]);
    expect(width).toBe(1);
    expect(lines(rows[0], "top")).toEqual([]);
    expect(lines(rows[1], "top")).toEqual(["0>0"]);
    expect(lines(rows[2], "bottom")).toEqual([]);
  });

  it("splits off and merges back in a second lane", () => {
    // m merges main's d with feature's f; both come from b.
    const { rows, width } = layoutGraph(commits("m:d f", "d:b", "f:b", "b:a", "a"));
    expect(lanes(rows)).toEqual([0, 0, 1, 0, 0]);
    expect(width).toBe(2);
    expect(rows[0].merge).toBe(true);
    expect(lines(rows[0], "bottom")).toEqual(["0>0", "0>1"]);
    // d passes f's lane by; b gathers both lines.
    expect(lines(rows[1], "bottom")).toEqual(["0>0", "1>1"]);
    expect(lines(rows[3], "top")).toEqual(["0>0", "1>0"]);
    expect(lines(rows[3], "bottom")).toEqual(["0>0"]);
  });

  it("gives every branch head its own lane", () => {
    const { rows } = layoutGraph(commits("x:b", "c:b", "b:a", "a"));
    expect(lanes(rows)).toEqual([0, 1, 0, 0]);
    expect(lines(rows[1], "top")).toEqual(["0>0"]);
    expect(lines(rows[2], "top")).toEqual(["0>0", "1>0"]);
  });

  it("draws octopus merges to every parent", () => {
    const { rows } = layoutGraph(commits("o:a b c", "a:r", "b:r", "c:r", "r"));
    expect(lines(rows[0], "bottom")).toEqual(["0>0", "0>1", "0>2"]);
    expect(lanes(rows)).toEqual([0, 0, 1, 2, 0]);
    expect(lines(rows[4], "top")).toEqual(["0>0", "1>0", "2>0"]);
  });

  it("fades lines to parents that aren't imported", () => {
    const { rows } = layoutGraph(commits("m:a qqq", "b:a", "a:zzz"));
    expect(lines(rows[0], "bottom")).toEqual(["0>0", "0>1~"]);
    expect(lines(rows[2], "top")).toEqual(["0>0", "1>0"]);
    expect(lines(rows[2], "bottom")).toEqual(["0>0~"]);
  });

  it("reuses lanes once a side line has ended", () => {
    // Two side branches one after the other, each merged back: still two lanes.
    const { width } = layoutGraph(commits("m2:m1 y", "y:m1", "m1:a x", "x:a", "a"));
    expect(width).toBe(2);
  });
});
