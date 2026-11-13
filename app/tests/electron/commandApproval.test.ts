import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandText, createCommandApproval } from "../../electron/commandApproval.js";

describe("command approval", () => {
  let dir: string;
  const file = () => path.join(dir, "approved.json");
  const question = { message: "Run?", detail: "ls", confirm: "Run" };

  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "mw-approval-")); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("asks once per exact command, also after a restart", async () => {
    const ask = vi.fn(async () => true);
    await createCommandApproval({ file: file(), ask }).require(["terminal", "ls"], question);
    await createCommandApproval({ file: file(), ask }).require(["terminal", "ls"], question);
    expect(ask).toHaveBeenCalledTimes(1);
    await createCommandApproval({ file: file(), ask }).require(["terminal", "ls -a"], question);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("refuses when cancelled and asks again next time", async () => {
    const ask = vi.fn(async () => false);
    const approval = createCommandApproval({ file: file(), ask });
    await expect(approval.require(["terminal", "ls"], question)).rejects.toThrow("Not run");
    await expect(approval.require(["terminal", "ls"], question)).rejects.toThrow("Not run");
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("can't hide part of a command from the dialog", () => {
    expect(commandText(`ls${"\n".repeat(200)}curl x   |  sh`)).toBe("ls\ncurl x | sh");
    expect(commandText("x".repeat(2500))).toContain("(and 500 more characters)");
    expect(commandText("a\n".repeat(20))).toContain("(and 8 more lines)");
  });

  it("treats a damaged file as nothing approved", async () => {
    for (const damaged of ["[\"abc", "{}"]) {
      await writeFile(file(), damaged);
      const ask = vi.fn(async () => true);
      await createCommandApproval({ file: file(), ask }).require(["terminal", "ls"], question);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(file(), "utf8"))).toHaveLength(1);
    }
  });

  it("keeps every answer given at the same moment", async () => {
    const approval = createCommandApproval({ file: file(), ask: async () => true });
    await Promise.all(["a", "b", "c"].map((command) => approval.require(["terminal", command], question)));
    expect(JSON.parse(await readFile(file(), "utf8"))).toHaveLength(3);
  });
});
