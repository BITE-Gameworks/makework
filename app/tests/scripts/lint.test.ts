// The repo's own checks for rules a pattern can see (scripts/lint.mjs, `npm run lint`).
import { describe, expect, it } from "vitest";
import { lintText } from "../../scripts/lint.mjs";

const rules = (path: string, text: string) => lintText(path, text).map((p) => p.rule);

describe("lint", () => {
  it("finds native pickers, autofocus and the browser's own dialogs in code", () => {
    expect(rules("src/a.tsx", '<select value="x">')).toEqual(["native-picker"]);
    expect(rules("src/a.tsx", "<datalist id=\"d\">")).toEqual(["native-picker"]);
    expect(rules("src/a.tsx", "<input autofocus />")).toEqual(["autofocus"]);
    expect(rules("src/a.tsx", "const n = window.prompt(\"Name\");")).toEqual(["browser-dialog"]);
    expect(rules("src/a.ts", "if (window.confirm(\"Sure?\")) go();")).toEqual(["browser-dialog"]);
    expect(rules("src/a.ts", "void navigator.clipboard?.writeText(url);")).toEqual(["clipboard"]);
  });

  it("leaves alone what only looks alike", () => {
    expect(rules("src/a.tsx", "// in place of the browser's <select>")).toEqual([]);
    expect(rules("src/a.tsx", "<Select label=\"x\" />")).toEqual([]);
    expect(rules("src/a.tsx", "const mismatch = () => confirm() !== password();")).toEqual([]);
    expect(rules("src/core/clipboard.ts", "await navigator.clipboard.writeText(text);")).toEqual([]);
    expect(rules("src/ui/clipboard.ts", "await navigator.clipboard.writeText(text);")).toEqual(["clipboard"]);
    expect(rules("src/node/page.ts", "await navigator.clipboard.writeText(code);")).toEqual([]);
  });

  it("keeps the main process off app.isPackaged, which the dev runs' renamed exe gets wrong", () => {
    expect(rules("electron/main.js", "const logging = app.isPackaged || debug;")).toEqual(["is-packaged"]);
    expect(rules("electron/preload.cjs", "if (!app.isPackaged) open();")).toEqual(["is-packaged"]);
    expect(rules("electron/installed.js", "export const installed = app.isPackaged && !process.defaultApp;")).toEqual([]);
    expect(rules("electron/main.js", "// Never read app.isPackaged here.")).toEqual([]);
    expect(rules("src/a.ts", "const packaged = app.isPackaged;")).toEqual([]);
  });

  it("finds hex colors in style sheets, except masks and marked lines", () => {
    expect(rules("src/a.css", "  color: #fff;")).toEqual(["hex-color"]);
    expect(rules("src/a.css", "  mask-image: linear-gradient(#000, transparent);")).toEqual([]);
    expect(rules("src/a.css", "  border: 2px solid #fff; /* lint-allow: the picker's own white */")).toEqual([]);
    expect(rules("src/a.ts", 'const fill = "#fff";')).toEqual([]);
  });

  it("keeps window drag areas out of views, which stay in the page while hidden", () => {
    expect(rules("src/voice/VoiceView.tsx", '<div class="voice-lobby" data-drag-region>')).toEqual(["drag-region"]);
    expect(rules("src/plugins/builtin/chat/ChatView.tsx", "<header data-drag-region>")).toEqual(["drag-region"]);
    expect(rules("src/shell/MainView.tsx", "<div class=\"empty-state\" data-drag-region>")).toEqual(["drag-region"]);
    expect(rules("src/a.ts", 'el.setAttribute("data-drag-region", "");')).toEqual(["drag-region"]);
    expect(rules("src/voice/voice.css", "  -webkit-app-region: drag;")).toEqual(["drag-region"]);
    expect(rules("src/shell/TabBar.tsx", '<div class="tab-bar" data-drag-region>')).toEqual([]);
    expect(rules("src/plugins/builtin/code/TerminalWindow.tsx", "<div data-drag-region>")).toEqual([]);
    expect(rules("src/shell/shell.css", "  -webkit-app-region: drag;")).toEqual([]);
    expect(rules("src/a.css", "  -webkit-app-region: no-drag;")).toEqual([]);
  });

  it("says where and what to use instead", () => {
    const [problem] = lintText("src/a.tsx", "ok\n<select>");
    expect(problem).toMatchObject({ line: 2, rule: "native-picker" });
    expect(problem.message).toMatch(/ui\/Select/);
  });
});
