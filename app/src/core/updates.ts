// Tells desktop users when a newer version is on the download page. The hosted web app is simply the newest already.
// Installing stays with the person: nothing here downloads or runs anything.
import { createSignal } from "solid-js";
import { desktop } from "./desktop";
import { showNotice } from "./notices";
import { userServerOffline } from "./userServer";
import { appVersion, compareVersions, validVersion } from "./version";

export const downloadPage = "https://makework.dev/download";

const checkEveryMs = 6 * 3_600_000;

const [available, setAvailable] = createSignal<string | null>(null);
export const updateAvailable = available;

let offered: string | null = null;
let started = false;

export function openDownloadPage(): void {
  window.open(downloadPage, "_blank", "noopener");
}

export async function checkForUpdate(): Promise<void> {
  if (userServerOffline()) return;
  const latest = await desktop?.latestVersion?.().catch(() => null);
  if (!validVersion(latest) || compareVersions(latest, appVersion) <= 0) return;
  setAvailable(latest);
  if (offered === latest) return;
  offered = latest;
  showNotice(`MakeWork ${latest} is available`, `You're on version ${appVersion}.`, [
    { label: "Download", run: openDownloadPage },
    { label: "Not now", run: () => {} },
  ]);
}

export function startUpdateChecks(): void {
  if (started || import.meta.env.DEV) return;
  started = true;
  void checkForUpdate();
  setInterval(() => void checkForUpdate(), checkEveryMs);
}
