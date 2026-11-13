// The repo's rules that a pattern can check (AGENTS.md "Consistency" and "Conventions"), so they hold without anyone
// remembering them: `npm run lint`, run in CI next to the typecheck and the tests. Each problem says what to use.
// A line can opt out with a `lint-allow: <why>` comment.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./isMain.mjs";

const code = /\.(ts|tsx)$/;
const dragRegion = "A hidden kept view keeps its window drag area over the view shown in its place, eating its " +
  "clicks: window dragging belongs to the shell's bars (tab bar, workspace bar, channel bar).";
const rules = [
  {
    rule: "native-picker", files: /\.tsx$/, pattern: /<(select|datalist)[\s>/]/,
    message: "A native <select> or <datalist> ignores the theme: use ui/Select or ui/Combobox.",
  },
  {
    rule: "autofocus", files: /\.tsx$/, pattern: /\bauto[fF]ocus\b/,
    message: "Browsers honor autofocus once per page: use ref={focusWhenShown} (ui/focus.ts).",
  },
  {
    rule: "browser-dialog", files: code, pattern: /\b(?:window|globalThis)\.(?:prompt|alert|confirm)\s*\(/,
    message: "Electron has no prompt() (it throws) and the browser's dialogs ignore the theme: use ui/Dialog or ui/ConfirmPrompt.",
  },
  {
    rule: "clipboard", files: code, pattern: /clipboard\??\.writeText\s*\(/,
    skip: /(^|\/)src\/(core\/clipboard\.ts|node\/page\.ts)$/,
    message: "A refused copy would go unnoticed: use copyText (core/clipboard.ts), or copyToClipboard or createCopied (ui/clipboard.ts).",
  },
  {
    rule: "drag-region", files: code, pattern: /\bdata-drag-region\b/,
    skip: /(^|\/)src\/(shell\/(TabBar|WorkspaceBar|ChannelBar|Auth)|plugins\/builtin\/code\/TerminalWindow)\.tsx$/,
    message: dragRegion,
  },
  {
    rule: "drag-region", files: /\.css$/, pattern: /app-region:\s*drag\b/, skip: /(^|\/)src\/shell\/shell\.css$/,
    message: dragRegion,
  },
  {
    rule: "hex-color", files: /\.css$/, pattern: /#[0-9a-fA-F]{3,8}\b/, unless: /mask-image/,
    message: "Colors come from the theme: use a var(--mw-...) color (a mask's #000 is fine).",
  },
  {
    rule: "is-packaged", files: /(^|\/)electron\/[^/]+\.(js|cjs)$/, pattern: /\bapp\.isPackaged\b/,
    skip: /(^|\/)electron\/installed\.js$/,
    message: "Electron counts the dev runs' renamed MakeWork-dev.exe as packaged: use `installed` (electron/installed.js).",
  },
];

const comment = /^\s*(\/\/|\/?\*)/;

// The problems in one file's text; `file` is its path (forward slashes), which decides the rules that apply.
export function lintText(file, text) {
  const problems = [];
  const name = file.replaceAll("\\", "/");
  text.split("\n").forEach((line, index) => {
    if (comment.test(line) || line.includes("lint-allow")) return;
    for (const r of rules) {
      if (!r.files.test(name) || r.skip?.test(name) || r.unless?.test(line) || !r.pattern.test(line)) continue;
      problems.push({ file: name, line: index + 1, rule: r.rule, message: r.message });
    }
  });
  return problems;
}

function* walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, files);
    else if (files.test(entry.name)) yield full;
  }
}

if (isMain(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const problems = [...walk(path.join(root, "src"), /\.(ts|tsx|css)$/), ...walk(path.join(root, "electron"), /\.(js|cjs)$/)]
    .flatMap((file) => lintText(path.relative(root, file), readFileSync(file, "utf8")));
  for (const p of problems) console.log(`${p.file}:${p.line} ${p.rule}: ${p.message}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}.`);
    process.exit(1);
  }
}
