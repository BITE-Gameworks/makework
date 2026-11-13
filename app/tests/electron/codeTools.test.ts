// Terminals of code channels in the main process (electron/codeTools.js), with a fake pty and fake windows: a
// terminal popped out into a terminal window keeps running, its output follows it, and closing that window returns it
// to the page it came from (2026-10-30).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cmdArg, createCodeTools } from "../../electron/codeTools.js";

type Sent = [string, ...unknown[]];

// A window's page as the main process sees it: what was sent to it, and its end.
function page() {
  const sent: Sent[] = [];
  const ends: (() => void)[] = [];
  let destroyed = false;
  return {
    sent,
    send: (...message: Sent) => void sent.push(message),
    isDestroyed: () => destroyed,
    once: (event: string, handler: () => void) => void (event === "destroyed" && ends.push(handler)),
    destroy() {
      destroyed = true;
      ends.splice(0).forEach((end) => end());
    },
  };
}

// A pty module whose processes are driven by the test.
function fakePty() {
  const spawned: { args: string[]; data: (text: string) => void; exit: (code: number) => void; killed: boolean }[] = [];
  return {
    spawned,
    module: {
      spawn(_program: string, args: string[]) {
        const listeners = { data: [] as ((text: string) => void)[], exit: [] as ((e: { exitCode: number }) => void)[] };
        const proc = {
          args, killed: false,
          data: (text: string) => listeners.data.forEach((l) => l(text)),
          exit: (code: number) => listeners.exit.forEach((l) => l({ exitCode: code })),
        };
        spawned.push(proc);
        return {
          onData: (l: (text: string) => void) => void listeners.data.push(l),
          onExit: (l: (e: { exitCode: number }) => void) => void listeners.exit.push(l),
          write() {},
          resize() {},
          kill() {
            proc.killed = true;
            proc.exit(1);
          },
        };
      },
    },
  };
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tools() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-code-"));
  dirs.push(dir);
  const pty = fakePty();
  const code = createCodeTools({ baseDir: dir, serversDir: dir, findContent: () => null, spawn: () => null, loadPty: async () => pty.module });
  return { code, pty };
}

const options = { workspaceId: "w1", channelId: 5, title: "Terminal", cols: 80, rows: 24 };

describe("terminals that move between windows", () => {
  it("sends the output to the terminal window that took the terminal, and returns it when that window closes", async () => {
    const { code, pty } = tools();
    const origin = page();
    const id = await code.startTerminal(origin, options);
    pty.spawned[0].data("before ");

    const away = page();
    const taken = code.adoptTerminal(away, id);
    expect(taken).toMatchObject({ workspaceId: "w1", channelId: 5, title: "Terminal", running: true, backlog: "before " });
    pty.spawned[0].data("while away");
    expect(away.sent).toContainEqual(["term:data", id, "while away"]);
    expect(origin.sent.filter(([channel]) => channel === "term:data")).toEqual([["term:data", id, "before "]]);

    away.destroy();
    expect(pty.spawned[0].killed).toBe(false);
    expect(origin.sent).toContainEqual(["term:returned", id, expect.objectContaining({ backlog: "before while away", running: true })]);
    pty.spawned[0].data("back");
    expect(origin.sent).toContainEqual(["term:data", id, "back"]);
  });

  it("keeps a popped-out terminal running when its origin goes, and ends it when its window closes then", async () => {
    const { code, pty } = tools();
    const origin = page();
    const id = await code.startTerminal(origin, options);
    const away = page();
    code.adoptTerminal(away, id);

    origin.destroy();
    expect(pty.spawned[0].killed).toBe(false);
    away.destroy();
    expect(pty.spawned[0].killed).toBe(true);
    expect(() => code.adoptTerminal(page(), id)).toThrow("That terminal has ended.");
  });

  it("ends a terminal with the page that started it", async () => {
    const { code, pty } = tools();
    const origin = page();
    await code.startTerminal(origin, options);
    origin.destroy();
    expect(pty.spawned[0].killed).toBe(true);
  });

  it("keeps only the last 256 KB of output for a page taking the terminal over", async () => {
    const { code, pty } = tools();
    const id = await code.startTerminal(page(), options);
    pty.spawned[0].data("x".repeat(300 * 1024));
    pty.spawned[0].data("end");
    const { backlog } = code.adoptTerminal(page(), id);
    expect(backlog).toHaveLength(256 * 1024);
    expect(backlog.endsWith("end")).toBe(true);
  });

  it("runs a Run again under the same terminal, and reports a stop as an exit", async () => {
    const { code, pty } = tools();
    const origin = page();
    const id = await code.startTerminal(origin, { ...options, command: "npm test" });
    code.killTerminal(id);
    expect(origin.sent).toContainEqual(["term:exit", id, 1]);

    await code.restartTerminal(id);
    expect(pty.spawned).toHaveLength(2);
    expect(pty.spawned[1].args.at(-1)).toBe("npm test");
    pty.spawned[1].data("again");
    expect(origin.sent).toContainEqual(["term:data", id, "again"]);
    expect(code.adoptTerminal(page(), id)).toMatchObject({ running: true, backlog: "again" });
  });
});

describe("cmdArg", () => {
  it("quotes what cmd.exe would split or read as its own", () => {
    expect(cmdArg("install")).toBe("install");
    expect(cmdArg("C:\\Users\\John Smith\\AppData")).toBe('"C:\\Users\\John Smith\\AppData"');
    expect(cmdArg("a&b")).toBe('"a&b"');
    expect(cmdArg("")).toBe('""');
    expect(() => cmdArg("50%")).toThrow();
  });
});
