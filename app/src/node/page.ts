// The invite page a node shows at https://<node>/<path set in Workspace settings > Nodes>: the server's name, picture
// and member count, and the code of the newest invite members chose to show there, to copy, in the MakeWork Dark theme. Everything shown comes from the server's data, so all of it is escaped.
import font from "@fontsource-variable/comfortaa/files/comfortaa-latin-wght-normal.woff2?inline";
import { themeVariables } from "../theme/apply";
import { parseTheme } from "../theme/parse";
import type { ThemeFile } from "../theme/schema";
import dark from "../theme/themes/makework-dark.json";

const theme = parseTheme(dark as ThemeFile, undefined);
const variables = Object.entries(themeVariables(theme)).map(([k, v]) => `${k}:${v}`).join(";");
const downloadUrl = "https://github.com/BITE-Gameworks/makework/releases";
const imageUrl = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export interface InviteInfo {
  name: string;
  icon: string;
  color: string;
  members: number;
  online: number;
  // The newest open invite a member chose to show on the nodes' pages; null while there is none.
  invite: string | null;
  node: string;
}

export function invitePage(info: InviteInfo): string {
  const name = info.name || "A MakeWork workspace";
  const picture = imageUrl.test(info.icon)
    ? `<img class="icon" src="${escapeHtml(info.icon)}" alt="">`
    : `<div class="icon" style="background:${/^#[0-9a-f]{3,8}$/i.test(info.color) ? info.color : "var(--mw-accent)"}">${escapeHtml(initials(name))}</div>`;
  const people = `${info.members} ${info.members === 1 ? "member" : "members"}${info.online ? ` · ${info.online} online` : ""}`;
  if (info.invite === null) return page(name, `
    <main class="card mw-box">
      ${picture}
      <h1>${escapeHtml(name)}</h1>
      <p class="hint">${people}</p>
      <p class="foot">No invite is open here right now. Ask a member of the workspace for one. Hosted by ${escapeHtml(info.node)}.</p>
    </main>`);
  return page(`Join ${name} on MakeWork`, `
    <main class="card mw-box">
      ${picture}
      <p class="hint">You're invited to join</p>
      <h1>${escapeHtml(name)}</h1>
      <p class="hint">${people}</p>
      <label class="label" for="code">Invite code</label>
      <div class="code-row">
        <input id="code" class="code mw-box" readonly value="${escapeHtml(info.invite)}">
        <button id="copy" class="button mw-box" type="button">Copy</button>
      </div>
      <ol class="steps">
        <li><a href="${downloadUrl}" rel="noopener">Get MakeWork</a> and sign in.</li>
        <li>Click <b>+</b> in the workspace bar and choose <b>Join</b>.</li>
        <li>Paste the invite code.</li>
      </ol>
      <p class="foot">Anyone with this code can join and read the workspace. Hosted by ${escapeHtml(info.node)}.</p>
    </main>
    <script>
      const code = document.getElementById("code");
      const copy = document.getElementById("copy");
      copy.addEventListener("click", async () => {
        code.select();
        try { await navigator.clipboard.writeText(code.value); } catch { document.execCommand("copy"); }
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
    </script>`);
}

export function notFoundPage(): string {
  return page("Not found", `
    <main class="card mw-box">
      <h1>Nothing here</h1>
      <p class="hint">This MakeWork node has no invite page at this address. Ask for a new link.</p>
    </main>`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${theme.colors.darker}">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
@font-face { font-family: "Comfortaa Variable"; src: url(${font}) format("woff2"); font-weight: 300 700; font-display: swap; }
:root { ${variables}; color-scheme: ${theme.scheme}; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: var(--mw-margin);
  background: var(--mw-darker); color: var(--mw-text); font-family: var(--mw-font-ui); font-size: var(--mw-font-size); }
.mw-box { border-radius: var(--mw-corner); }
.card { width: min(420px, 100%); background: var(--mw-dark); padding: calc(var(--mw-margin) * 2); display: flex;
  flex-direction: column; align-items: center; text-align: center; gap: calc(var(--mw-margin) / 2);
  border: var(--mw-border-width) solid var(--mw-light); animation: in 300ms ease-out; }
@keyframes in { from { opacity: 0; transform: translateY(8px); } }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }
.icon { width: 80px; height: 80px; border-radius: calc(var(--mw-corner) * 4); object-fit: cover; display: grid; place-items: center;
  font-size: 28px; font-weight: 700; color: var(--mw-accent-text); margin-bottom: calc(var(--mw-margin) / 2); }
h1 { margin: 0; font-size: 1.6em; }
.hint { margin: 0; color: var(--mw-text-muted); }
.label { align-self: flex-start; margin-top: var(--mw-margin); color: var(--mw-text-muted); font-size: 0.9em; }
.code-row { display: flex; gap: calc(var(--mw-margin) / 2); width: 100%; }
.code { flex: 1; min-width: 0; padding: 8px 10px; background: var(--mw-light); color: var(--mw-text); border: none;
  font-family: var(--mw-font-code); font-size: 0.85em; }
.button { padding: 8px 16px; border: none; background: var(--mw-accent); color: var(--mw-accent-text); font: inherit;
  font-weight: 700; cursor: pointer; transition: opacity 150ms; }
.button:hover { opacity: 0.85; }
.steps { align-self: stretch; text-align: left; margin: var(--mw-margin) 0 0; padding-left: 1.4em; line-height: 1.8; color: var(--mw-text-muted); }
.steps b { color: var(--mw-text); }
a { color: var(--mw-link); }
.foot { margin: var(--mw-margin) 0 0; font-size: 0.8em; color: var(--mw-text-disabled); }
</style>
</head>
<body>${body}</body>
</html>
`;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join("").toUpperCase();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);
}
