import { describe, expect, it } from "vitest";
import { parseBlocks } from "../../src/markdown/parse";

describe("parseBlocks", () => {
  it("reads headings, fences, rules and paragraphs", () => {
    const blocks = parseBlocks("# Title\n\nSome text\nmore text\n\n```ts\nconst a = 1;\n```\n---\nend");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "code", "hr", "paragraph"]);
    expect(blocks[2]).toEqual({ type: "code", lang: "ts", code: "const a = 1;" });
  });

  it("nests lists by indentation", () => {
    const [list] = parseBlocks("- one\n- two\n  - two a\n  - two b\n- three");
    expect(list.type === "list" && list.items.length).toBe(3);
    const second = list.type === "list" ? list.items[1] : [];
    expect(second.map((b) => b.type)).toEqual(["paragraph", "list"]);
  });

  it("reads tables with alignment and quotes", () => {
    const [table, quote] = parseBlocks("| a | b |\n|:--|--:|\n| 1 | 2 |\n\n> quoted\n> text");
    expect(table).toEqual({ type: "table", head: ["a", "b"], align: ["left", "right"], rows: [["1", "2"]] });
    expect(quote.type).toBe("quote");
  });

  it("keeps an unclosed fence as code to the end", () => {
    expect(parseBlocks("```\nno end")).toEqual([{ type: "code", lang: "", code: "no end" }]);
  });

  it("reads a heading's text without its closing #s", () => {
    const read = (line: string) => {
      const [block] = parseBlocks(line);
      return block.type === "heading" ? `${block.level}:${block.text}` : block.type;
    };
    expect(read("## Title ##")).toBe("2:Title");
    expect(read("#   Spaced   ")).toBe("1:Spaced");
    expect(read("### a # b")).toBe("3:a # b");
    expect(read("# C#")).toBe("1:C");
    expect(read("# # #")).toBe("1:#");
    expect(read("#nospace")).toBe("paragraph");
    expect(read("####### seven")).toBe("paragraph");
  });

  it("reads fences with and without a language, and empty list items", () => {
    expect(parseBlocks("~~~  c++  \nx\n~~~")).toEqual([{ type: "code", lang: "c++", code: "x" }]);
    expect(parseBlocks("```   \nx\n```")).toEqual([{ type: "code", lang: "", code: "x" }]);
    expect(parseBlocks("``` two words\nx\n```")[0].type).toBe("paragraph");
    const [list] = parseBlocks("3. three\n4. \n5. five");
    expect(list.type === "list" && [list.ordered, list.start, list.items.map((item) => item.length)]).toEqual([true, 3, [1, 0, 1]]);
  });

  it("takes table separators with or without outer pipes", () => {
    for (const separator of ["|---|---|", "---|---", " | :-: | -- | ", "|:--|--:"]) {
      expect(parseBlocks(`a | b\n${separator}\n1 | 2`)[0].type).toBe("table");
    }
    expect(parseBlocks("a | b\n|---|x|\n1 | 2")[0].type).toBe("paragraph");
  });

  // Lines from other members: none of these may cost more than a pass or two over the line.
  it("stays quick on long crafted lines", () => {
    const lines = [
      `# ${" #".repeat(20_000)} x`,
      `\`\`\`${" ".repeat(50_000)}!`,
      `- ${" ".repeat(50_000)}\r x`,
      `a|b\n|${" ".repeat(50_000)}x`,
    ];
    const started = performance.now();
    for (const line of lines) parseBlocks(line);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
