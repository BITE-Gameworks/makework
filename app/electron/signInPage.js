// The page the system browser shows when a sign-in comes back to the app's loopback port. The user server's
// worker.js keeps a copy of this look for its own pages.
const escapeHtml =(text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const icons = {
  ok: '<path d="M20 6 9 17l-5-5"/>',
  error: '<path d="M18 6 6 18M6 6l12 12"/>',
};

export function signInPage({ ok, title, message }) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(title)} - MakeWork</title>
<style>
  :root { --bg: #020203; --card: #08071d; --text: #ecf6ff; --muted: #acbdcd; --accent: #2f78e4; --ok: #4ce1a0; --error: #e53935; --border: #3d52ae; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #dfe4f4; --card: #ffffff; --text: #0b0e28; --muted: #3c4766; --accent: #2a6ad8; --ok: #16935e; --error: #c62828; --border: #6574c0; }
  }
  * { box-sizing: border-box; }
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { display: flex; flex-direction: column; align-items: center; gap: 12px; width: min(400px, 100%); padding: 32px 24px; border: 2px solid var(--border); border-radius: 2px; background: var(--card); text-align: center; }
  .icon { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 50%; background: color-mix(in srgb, var(--tone) 16%, transparent); color: var(--tone); }
  .icon svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
  h1 { margin: 4px 0 0; font-size: 1.3rem; }
  p { margin: 0; color: var(--muted); }
  .brand { margin-top: 12px; color: var(--accent); font-weight: 700; letter-spacing: 0.02em; }
</style>
<main style="--tone: var(${ok ? "--ok" : "--error"})">
  <div class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">${ok ? icons.ok : icons.error}</svg></div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <div class="brand">MakeWork</div>
</main>
</html>`;
}
