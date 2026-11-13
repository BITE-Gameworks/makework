import { describe, expect, it } from "vitest";
import { diff3, editorText, isPicked, pickedLines, preset, resolvedText, startPicks, toDiffLines, togglePick, writtenChoice } from "../../../../src/plugins/builtin/git/merge";

const text = (...lines: string[]) => lines.map((l) => `${l}\n`).join("");

describe("merging a file's three versions", () => {
  it("takes a change made on one side only, with nothing to decide", () => {
    const base = text("a", "b", "c", "d", "e");
    const receiving = text("a", "B", "c", "d", "e");
    const incoming = text("a", "b", "c", "d", "E");
    const regions = diff3(base, receiving, incoming)!;
    expect(regions.filter((r) => r.kind === "conflict")).toHaveLength(0);
    expect(resolvedText(regions, [])).toBe(text("a", "B", "c", "d", "E"));
  });

  it("finds a conflict where both sides changed the same lines, undecided until chosen", () => {
    const base = text("start", "const a = 1;", "return a;", "end");
    const receiving = text("start", "const a = 1;", "log(\"start\")", "return a;", "end");
    const incoming = text("start", "const a = 1;", "log(\"begin\", id)", "return a + b;", "end");
    const regions = diff3(base, receiving, incoming)!;
    const conflicts = regions.filter((r) => r.kind === "conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].rows).toEqual([
      { receiving: "log(\"start\")", incoming: "log(\"begin\", id)", shared: false },
      { receiving: "return a;", incoming: "return a + b;", shared: false },
    ]);
    expect(resolvedText(regions, [])).toBeNull();
    // The receiving branch's first line and the incoming branch's second.
    expect(resolvedText(regions, [{ picks: ["0:r", "1:i"] }])).toBe(text("start", "const a = 1;", "log(\"start\")", "return a + b;", "end"));
  });

  it("keeps lines both sides share once, and puts the receiving branch's picks before the incoming ones", () => {
    const rows = diff3("", text("const a = 1;", "log(\"start\")", "return a;"), text("const a = 1;", "log(\"begin\", id)", "return a + b;"))!
      .find((r) => r.kind === "conflict")!.rows;
    expect(rows[0]).toEqual({ receiving: "const a = 1;", incoming: "const a = 1;", shared: true });
    // Both: everything, the receiving block first.
    const all = rows.flatMap((_row, n) => [`${n}:r`, `${n}:i`]);
    expect(pickedLines(rows, { picks: all }).slice(0, 5)).toEqual(["const a = 1;", "log(\"start\")", "return a;", "log(\"begin\", id)", "return a + b;"]);
  });

  it("gives back exactly the changed version when only one side changed, or both the same way", () => {
    // A small seeded generator: the same cases every run.
    let seed = 7;
    const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    const edit = (lines: string[]) => {
      const out = [...lines];
      for (let k = random(6); k >= 0; k--) {
        const at = random(out.length + 1);
        const what = random(3);
        if (what === 0) out.splice(at, 1);
        else if (what === 1) out.splice(at, 0, `new ${random(5)}`);
        else out[at] = `changed ${random(5)}`;
      }
      return out;
    };
    for (let n = 0; n < 300; n++) {
      const base = Array.from({ length: random(30) }, () => `line ${random(8)}`);
      const changed = edit(base);
      const [b, c] = [base.join("\n"), changed.join("\n")];
      expect(resolvedText(diff3(b, c, b)!, [])).toBe(c);
      expect(resolvedText(diff3(b, b, c)!, [])).toBe(c);
      expect(resolvedText(diff3(b, c, c)!, [])).toBe(c);
    }
  });

  it("keeps a missing final newline and CRLF line endings", () => {
    const base = "a\r\nb\r\nc\r\nd";
    expect(resolvedText(diff3(base, "A\r\nb\r\nc\r\nd", "a\r\nb\r\nc\r\nD")!, [])).toBe("A\r\nb\r\nc\r\nD");
  });
});

describe("a side's changes as diff lines", () => {
  it("numbers both sides and keeps three lines of context around a change", () => {
    const before = text("1", "2", "3", "4", "5", "6", "7", "8", "9");
    const after = text("1", "2", "3", "4", "5", "6", "7", "eight", "9");
    expect(toDiffLines(before, after)).toEqual([
      { kind: "hunk", text: "@@ -5,5 +5,5 @@" },
      { kind: "context", text: "5", oldNo: 5, newNo: 5 },
      { kind: "context", text: "6", oldNo: 6, newNo: 6 },
      { kind: "context", text: "7", oldNo: 7, newNo: 7 },
      { kind: "del", text: "8", oldNo: 8 },
      { kind: "add", text: "eight", newNo: 8 },
      { kind: "context", text: "9", oldNo: 9, newNo: 9 },
    ]);
    expect(toDiffLines("", text("new"))).toEqual([{ kind: "hunk", text: "@@ -0,0 +1,1 @@" }, { kind: "add", text: "new", newNo: 1 }]);
  });
});

describe("choosing lines in a conflict", () => {
  const rows = diff3("x\n", "x\nshared\nmine\n", "x\nshared\ntheirs\n")!.find((r) => r.kind === "conflict")!.rows;

  it("starts with the lines both sides share ticked", () => {
    expect(pickedLines(rows, { picks: startPicks(rows) })).toEqual(["shared"]);
  });

  it("takes one side, both, or neither side's own lines", () => {
    expect(pickedLines(rows, preset(rows, "receiving"))).toEqual(["shared", "mine"]);
    expect(pickedLines(rows, preset(rows, "incoming"))).toEqual(["shared", "theirs"]);
    expect(pickedLines(rows, preset(rows, "both"))).toEqual(["shared", "mine", "theirs"]);
    expect(pickedLines(rows, preset(rows, "neither"))).toEqual(["shared"]);
  });

  it("ticks and unticks single lines, a shared line on both sides at once", () => {
    const mineAt = rows.findIndex((r) => r.receiving === "mine");
    const theirsAt = rows.findIndex((r) => r.incoming === "theirs");
    const sharedAt = rows.findIndex((r) => r.shared);
    let choice = togglePick(rows, undefined, theirsAt, "incoming");
    expect(pickedLines(rows, choice)).toEqual(["shared", "theirs"]);
    choice = togglePick(rows, choice, mineAt, "receiving");
    expect(pickedLines(rows, choice)).toEqual(["shared", "mine", "theirs"]);
    choice = togglePick(rows, choice, sharedAt, "incoming");
    expect(pickedLines(rows, choice)).toEqual(["mine", "theirs"]);
    expect(isPicked(choice, sharedAt, "receiving")).toBe(false);
  });

  it("uses a result written by hand, where an empty one means no lines", () => {
    expect(pickedLines(rows, { text: "one\ntwo" })).toEqual(["one", "two"]);
    expect(pickedLines(rows, { text: "" })).toEqual([]);
  });

  it("keeps CRLF lines when a result is written by hand (a text box only gives LF)", () => {
    const crlf = diff3("x\r\n", "x\r\nmine\r\n", "x\r\ntheirs\r\n")!.find((r) => r.kind === "conflict")!.rows;
    expect(editorText(["mine\r", "theirs\r"])).toBe("mine\ntheirs");
    expect(pickedLines(crlf, writtenChoice(crlf, "mine\nboth"))).toEqual(["mine\r", "both\r"]);
    expect(pickedLines(rows, writtenChoice(rows, "mine\nboth"))).toEqual(["mine", "both"]);
    expect(pickedLines(crlf, writtenChoice(crlf, ""))).toEqual([]);
  });
});
