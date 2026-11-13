import { beforeEach, describe, expect, it, vi } from "vitest";
import { crashText, reportCrash, scrub } from "../../src/core/crashReports";
import { notices } from "../../src/core/notices";

describe("scrub", () => {
  it("keeps file names and drops the folders around them", () => {
    expect(scrub("at f (file:///home/me/app/dist/index-a1.js:10:2)")).toBe("at f (index-a1.js:10:2)");
    expect(scrub("at f (https://app.makework.dev/assets/x.js?t=1:3:4)")).toBe("at f (x.js:3:4)");
    expect(scrub("can't open /home/me/secret plans/a.txt")).toBe("can't open secret plans/a.txt");
    expect(scrub("can't open C:\\Users\\me\\a.txt")).toBe("can't open a.txt");
  });

  it("leaves ordinary words with a slash alone", () => {
    expect(scrub("and/or src/core/a.ts:1")).toBe("and/or src/core/a.ts:1");
  });

  it("removes addresses and long values", () => {
    expect(scrub("sent by me.name+x@mail.example.com")).toBe("sent by [email]");
    expect(scrub("two glued: a@b.cd+e@f.gh, done")).toBe("two glued: [email][email], done");
    expect(scrub(`token ${"a1B2".repeat(12)} refused`)).toBe("token [long value] refused");
  });
});

describe("reportCrash", () => {
  beforeEach(() => vi.resetModules());

  it("cuts a long report and says where it happened", () => {
    const error = new Error("x".repeat(20));
    error.stack = `Error: ${"word ".repeat(5000)}`;
    const report = crashText(error, "uncaught error");
    expect(report.startsWith("Where: uncaught error\nError: word")).toBe(true);
    expect(report).toHaveLength(8000);
  });

  it("only offers a report, and only once a session", () => {
    const before = notices().length;
    reportCrash(new Error("first"), "uncaught error");
    reportCrash(new Error("second"), "uncaught error");
    expect(notices()).toHaveLength(before + 1);
    expect(notices().at(-1)!.actions!.map((action) => action.label)).toEqual(["Review report", "Not now"]);
  });
});
