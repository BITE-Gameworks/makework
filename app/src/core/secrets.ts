// Personal access tokens (GitHub, GitLab, ...) kept on this device for the signed-in account, by name: a host's own
// slot, a named host connection's "<host>#<id>" (plugins/builtin/git/connections.ts) or a plugin's secret. They are
// only ever sent to that host's API, never into server data. Desktop keeps them encrypted with the system
// keychain; a browser can only keep them in its own storage, unencrypted.
import { createSignal } from "solid-js";
import { account } from "./account";
import { desktop, desktopError } from "./desktop";
import { readJson, writeJson } from "./storage";

const keyFor = (host: string) => `${account()?.id ?? "nobody"}:${host.toLowerCase()}`;
const browserKey = () => `mw.tokens.${account()?.id ?? "nobody"}`;

// "encrypted" on desktop with a keychain, "plain" in a browser, "none" on desktop without a keychain.
export async function tokenStorage(): Promise<"encrypted" | "plain" | "none"> {
  if (desktop?.secrets) return (await desktop.secrets.available()) ? "encrypted" : "none";
  return "plain";
}

// Null when none is kept, or it can't be read right now (then the request goes without one).
export async function getToken(host: string): Promise<string | null> {
  if (desktop?.secrets) return desktop.secrets.get(keyFor(host)).catch((e) => { console.warn("Token not read:", e); return null; });
  return readJson<Record<string, string>>(browserKey(), {})[host.toLowerCase()] ?? null;
}

// Changes after every token added, replaced or forgotten here, so views that depend on what a token may do (the
// version control view's releases) check again.
const [revision, setRevision] = createSignal(0);
export const tokenRevision = revision;

export async function setToken(host: string, token: string): Promise<void> {
  try {
    if (desktop?.secrets) {
      try {
        return await desktop.secrets.set(keyFor(host), token);
      } catch (e) {
        throw desktopError(e);
      }
    }
    writeJson(browserKey(), { ...readJson<Record<string, string>>(browserKey(), {}), [host.toLowerCase()]: token });
  } finally {
    setRevision((n) => n + 1);
  }
}

export async function forgetToken(host: string): Promise<void> {
  try {
    if (desktop?.secrets) return await desktop.secrets.remove(keyFor(host));
    const { [host.toLowerCase()]: _forgotten, ...rest } = readJson<Record<string, string>>(browserKey(), {});
    writeJson(browserKey(), rest);
  } finally {
    setRevision((n) => n + 1);
  }
}
