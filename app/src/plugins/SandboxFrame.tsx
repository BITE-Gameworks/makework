// Runs UI sent by a workspace in a sandboxed iframe. The frame has an opaque origin (no allow-same-origin),
// so it can't touch the app, its storage or other workspaces, and a CSP that blocks all network access.
// Its only way out is the message bridge, which pins every request to one plugin on one workspace.
import { Show, createEffect, createResource, onCleanup, onMount } from "solid-js";
import comfortaaUrl from "@fontsource-variable/comfortaa/files/comfortaa-latin-wght-normal.woff2?url";
import { ApiRequestError, type ApiClient } from "../api/client";
import type { ApiRequest } from "../api/types";
import { themeVariables } from "../theme/apply";
import { theme } from "../theme/store";

export interface SandboxContext {
  workspace: { id: string; name: string };
  /** @deprecated Use workspace. */
  server: { id: string; name: string };
  channel: { id: number; name: string; type: string; category: string };
  user: { username: string; displayName: string };
}

// The frame's opaque origin can't load the app's font files (fonts need CORS), so it gets a data URL.
let fontDataUrl: Promise<string> | undefined;
function loadFontDataUrl(): Promise<string> {
  fontDataUrl ??= fetch(comfortaaUrl)
    .then((response) => response.blob())
    .then((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("The font couldn't be read."));
      reader.readAsDataURL(blob);
    }))
    .catch(() => "");
  return fontDataUrl;
}

// Injected before the workspace's HTML: the window.makework API and the theme variables.
const bootstrap = `<script>
(() => {
  let next = 1;
  const pending = new Map();
  const listeners = new Set();
  let resolveReady;
  const send = (message) => parent.postMessage({ mw: 1, ...message }, "*");
  const applyTheme = (vars) => { for (const k in vars) document.documentElement.style.setProperty(k, vars[k]); };
  window.makework = {
    context: null,
    ready: new Promise((resolve) => (resolveReady = resolve)),
    request(request) {
      const id = next++;
      send({ type: "request", id, request });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  addEventListener("message", (event) => {
    const m = event.data;
    if (event.source !== parent || m?.mw !== 1) return;
    if (m.type === "init") { makework.context = m.context; applyTheme(m.theme); resolveReady(m.context); }
    else if (m.type === "theme") applyTheme(m.theme);
    else if (m.type === "event") listeners.forEach((l) => l(m.event));
    else if (m.type === "response") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.response.ok) p.resolve(m.response.data);
      else p.reject(Object.assign(new Error(m.response.error.message), { code: m.response.error.code }));
    }
  });
  send({ type: "hello" });
})();
</script>`;

// A srcdoc frame would inherit the app's CSP, which refuses inline scripts: the frame loads public/sandbox.html, whose
// own CSP allows them and blocks the network, and gets this document from there.
const shellUrl = `${import.meta.env.BASE_URL}sandbox.html`;

function viewDocument(html: string, font: string): string {
  const fontFace = font
    ? `@font-face { font-family: 'Comfortaa Variable'; src: url("${font}") format("woff2-variations"); font-weight: 300 700; font-display: swap; }`
    : "";
  const base = `<style>${fontFace} html { color-scheme: ${theme().scheme}; } body { background: transparent; }</style>`;
  return `<!doctype html>${base}${bootstrap}${html}`;
}

export default function SandboxFrame(props: { html: string; api: ApiClient; plugin: string; context: SandboxContext }) {
  let frame: HTMLIFrameElement | undefined;
  // Built once per HTML: a new document loads a new frame.
  const [doc] = createResource(() => props.html, async (html) => viewDocument(html, await loadFontDataUrl()));
  const post =(message: object) => frame?.contentWindow?.postMessage({ mw: 1, ...message }, "*");

  const handle = async (id: unknown, request: Partial<ApiRequest>) => {
    try {
      const data = await props.api.request({
        plugin: props.plugin,
        action: String(request.action ?? ""),
        table: typeof request.table === "string" ? request.table : undefined,
        where: request.where,
        values: request.values,
        args: request.args,
      });
      post({ type: "response", id, response: { ok: true, data } });
    } catch (e) {
      const error = e instanceof ApiRequestError
        ? { code: e.code, message: e.message }
        : { code: "internal_error", message: "Could not reach the server." };
      post({ type: "response", id, response: { ok: false, error } });
    }
  };

  const onMessage = (event: MessageEvent) => {
    const m = event.data;
    if (!frame || event.source !== frame.contentWindow || m?.mw !== 1) return;
    if (m.type === "shell") post({ type: "document", html: doc() });
    else if (m.type === "hello") post({ type: "init", context: props.context, theme: themeVariables(theme()) });
    else if (m.type === "request" && typeof m.request === "object" && m.request !== null) void handle(m.id, m.request);
  };

  onMount(() => {
    addEventListener("message", onMessage);
    const unsubscribe = props.api.plugin(props.plugin).onEvent((event) => post({ type: "event", event }));
    onCleanup(() => {
      removeEventListener("message", onMessage);
      unsubscribe();
    });
  });

  createEffect(() => post({ type: "theme", theme: themeVariables(theme()) }));

  return (
    <Show when={doc()} keyed>
      <iframe ref={frame} class="sandbox-frame" sandbox="allow-scripts" src={shellUrl} title={props.context.channel.name} />
    </Show>
  );
}
