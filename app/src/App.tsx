/* @refresh reload */
import { createEffect, createMemo, createSignal, Match, on, onMount, Switch } from "solid-js";
import { account, restoreSession } from "./core/account";
import { openWorkspace, restoreTabs, seedPopoutTab } from "./core/navigation";
import { isPopout, popoutPlace } from "./core/popout";
import { onlinePeers, refreshWorkspaceConnections, startServerless, startWorkspace } from "./core/serverless";
import { startMessages, stopMessages } from "./dm/messages";
import { startUpdateChecks } from "./core/updates";
import { setBootStatus } from "./core/ui";
import { startIdleTracker } from "./core/idle";
import { registerBuiltInPlugins } from "./plugins/builtin";
import { loadInstalledPlugins } from "./plugins/registry";
import PerfMeter from "./dev/PerfMeter";
import Auth from "./shell/Auth";
import OpenLinkPrompt from "./shell/OpenLinkPrompt";
import { linksReady } from "./core/openLinks";
import PopoutShell from "./shell/PopoutShell";
import Shell from "./shell/Shell";

registerBuiltInPlugins();

let networkModeChanges = 0;

export default function App() {
  const [restoring, setRestoring] = createSignal(true);
  onMount(async () => {
    startIdleTracker();
    try {
      await restoreSession();
    } catch (e) {
      console.warn("Saved session not restored:", e);
    }
    setRestoring(false);
  });
  // A memo, so profile edits (same id) don't start everything again; only signing in to an account does.
  const accountId = createMemo(() => account()?.id);
  createEffect(on(accountId, (id) => id && void start()));
  let activeAccount: string | null = null;
  let lastOfflineMode = false;
  createEffect(() => {
    const me = account();
    if (!me) return;
    if (activeAccount !== me.id) {
      activeAccount = me.id;
      lastOfflineMode = !!me.offlineMode;
      return;
    }
    const offline = !!me.offlineMode;
    if (offline === lastOfflineMode) return;
    lastOfflineMode = offline;
    void changeNetworkMode(offline);
  });

  return (
    <>
      <Switch>
        <Match when={account()}>{isPopout() ? <PopoutShell /> : <Shell />}</Match>
        <Match when={!restoring()}><Auth /></Match>
      </Switch>
      <OpenLinkPrompt />
      {import.meta.env.DEV && <PerfMeter />}
    </>
  );
}

async function start() {
  const networkModeAtStart = networkModeChanges;
  // Kept files must not be cleared when the disk fills up.
  void navigator.storage?.persist?.().catch(() => {});
  try {
    setBootStatus("Loading plugins...");
    await loadInstalledPlugins();
    if (!isPopout()) startUpdateChecks();
    if (isPopout()) {
      // A view window opens the one workspace it was given and shows that one tab. Nothing account-wide (calls,
      // notifications, private messages, bots) starts here: the main window owns all of that.
      const place = popoutPlace();
      if (place) {
        setBootStatus("Opening the workspace...");
        if (!(await startWorkspace(place.workspaceId))) console.warn(`This computer hasn't joined ${place.workspaceId}.`);
        seedPopoutTab(place);
      }
      return;
    }
    setBootStatus("Opening workspaces...");
    const connected = await startServerless();
    // Create the Explore MakeWork preset if none exist and it hasn't been offered yet.
    try {
      const { ensureExplorePreset } = await import("./core/exploreAuto");
      await ensureExplorePreset(connected.length);
      const after = connected;
      // If we just created it, the list may have grown; but easier to just proceed.
      if (!restoreTabs(after) && after[0]) openWorkspace(after[0]);
    } catch {
      if (!restoreTabs(connected) && connected[0]) openWorkspace(connected[0]);
    }
    // Links opened from outside go on top of the restored tabs.
    linksReady();

    // A status change can race the first open: refresh the newly attached workspaces in the current mode.
    if (networkModeAtStart !== networkModeChanges) await refreshWorkspaceConnections();
    startMessages();

    if (connected.length > 0 && !account()?.offlineMode) {
      setBootStatus("Connecting to members...");
      await membersOnline(connected, 2500);
    }
  } finally {
    setBootStatus(null);
  }
}

async function changeNetworkMode(offline: boolean): Promise<void> {
  networkModeChanges++;
  if (isPopout()) {
    // A view window only follows its own workspace; private messages and everything account-wide stay in the main.
    await refreshWorkspaceConnections();
    return;
  }
  if (offline) stopMessages("Offline mode is on. Choose Online, Do not disturb or Hidden to reconnect.");
  await refreshWorkspaceConnections();
  if (!offline) startMessages();
}

// Resolves once any of the workspaces has a member online, or after `maxMs` (everyone may be offline).
function membersOnline(workspaceIds: string[], maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (workspaceIds.some((id) => onlinePeers(id) > 0) || Date.now() - started >= maxMs) resolve();
      else setTimeout(check, 100);
    };
    check();
  });
}
