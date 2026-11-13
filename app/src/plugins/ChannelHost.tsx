// Shows a channel with the best view available: a local plugin's view, else the UI the workspace's
// plugin sends (sandboxed), else a generic view built from describe.
import { loaderFor } from "../core/channelTypes";
import Skeleton from "../ui/Skeleton";
import { reportCrash } from "../core/crashReports";
import { ErrorBoundary, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, onCleanup, type JSX } from "solid-js";
import { userMessage } from "../api/client";
import type { PluginInfo } from "../api/types";
import { assignableMembers, member, memberListVisible, myId } from "../core/members";
import { canInChannel, findCategory, workspaceApi, workspaces, type Channel } from "../core/workspaces";
import { account } from "../core/account";
import { setSidePanel, sidePanel, sidePanelShowing, toggleSidePanel } from "../core/ui";
import GenericView from "./GenericView";
import {
  channelViewFor, comparePluginVersions, installPlugin, isEnabled, pluginAsset, pluginOfType, pluginPackage, setEnabled, updatePlugin,
} from "./registry";
import { pluginSecret, pluginSetting } from "./settings";
import { updateWorkspacePlugin } from "./workspace";
import { can } from "../core/roles";
import SandboxFrame from "./SandboxFrame";
import { openFile } from "../core/files";
import MountPoint from "./MountPoint";
import { current } from "../core/navigation";
import { linkUrl, openLink } from "../core/links";
import { openContextMenu } from "../ui/contextMenu";
import { userMenu } from "../shell/userMenu";
import { playSound } from "../theme/sounds";
import { historyFor } from "../core/history";
import { channelPresence, channelStreams, onChannelEvent, sendChannelEvent, shareChannelStream, type CursorPoint } from "../core/presence";
import RemoteCursors from "../ui/RemoteCursors";
import { render } from "solid-js/web";
import { isPermission } from "../p2p/permissions";
import { contentBlob, ensureLocal, isForgotten, refHash } from "../core/content";
import { unzipSync, strFromU8 } from "fflate";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import { parseDeclared } from "../system/declared";
import ForgottenChannel from "../shell/ForgottenChannel";
import { contentHosting } from "../p2p/nodes";
import type { ChannelContext, ChannelView } from "./types";

type Remote = { kind: "sandbox"; html: string } | { kind: "generic"; info: PluginInfo } | { kind: "none" };
type WorkspacePlugin = { id: string; version: string; package: string; manifest: string; status: string };

// `active` is false while the kept view holding this channel is hidden: its presence and cursor are taken back,
// its side panels closed and its API client quiet (plugins/live.ts) until it shows again.
export default function ChannelHost(props: { workspaceId: string; channel: Channel; fallback: JSX.Element; active?: boolean }) {
  const active = () => props.active ?? true;
  const api = () => workspaceApi(props.workspaceId);
  // One client as long as the workspace connection and channel type stay (a reconnect makes a new one): the
  // view's live stores read `active` from it, so every call hands out the same instance.
  const ext = createMemo(() => api().plugin(props.channel.type, active));
  const local = () => channelViewFor(props.channel.type);
  const disabledPlugin = () => {
    const found = pluginOfType(props.channel.type);
    return found && !isEnabled(found.plugin.manifest.id) ? found : undefined;
  };
  const [pluginTick, setPluginTick] = createSignal(0);
  const [workspaceLoaded, setWorkspaceLoaded] = createSignal(false);
  const stopPluginEvents = api().onEvent((event) => {
    if (event.plugin === "channels" && ["channels_plugins", "channels_plugin_state"].includes(event.table))
      setPluginTick((tick) => tick + 1);
  });
  onCleanup(stopPluginEvents);
  const [workspacePlugin] = createResource(() => {
    pluginTick();
    return props.channel.type;
  }, async (type): Promise<WorkspacePlugin | undefined> => {
    try {
      const channels = api().plugin("channels");
      const [registrations, states] = await Promise.all([
        channels.read("channels_plugins"),
        channels.read("channels_plugin_state"),
      ]);
      const row = registrations.find((item) => {
        try { return parseDeclared(String(item.manifest)).name === type; }
        catch { return false; }
      });
      if (!row) return undefined;
      const state = states.find((item) => item.plugin_id === row.plugin_id);
      return {
        id: String(row.plugin_id),
        version: String(row.version),
        package: String(row.package),
        manifest: String(row.manifest),
        status: String(state?.status ?? "enabled"),
      };
    } finally {
      setWorkspaceLoaded(true);
    }
  });
  const workspacePluginInactive = () => !!workspacePlugin() && workspacePlugin()!.status !== "enabled";
  // A channel forgotten on this device gets a placeholder instead of its view; the view would fetch the
  // channel's content again as soon as it mounted (docs, ref sheets and design sync on mount).
  const forgotten = () => isForgotten(props.workspaceId, props.channel.id);

  // Panel keys are scoped to the channel, and its panels close when the channel's view goes away.
  const panelPrefix = `${props.workspaceId}:${props.channel.id}:`;
  const panelKey = (key: string) => panelPrefix + key;
  onCleanup(() => sidePanel()?.key?.startsWith(panelPrefix) && setSidePanel(null));

  const presence = channelPresence(props.workspaceId, props.channel.id);
  let shownState: Parameters<typeof presence.set>[0] = null;
  let shownCursor: CursorPoint | null = null;
  const setPresence = (state: typeof shownState) => {
    shownState = state;
    if (active()) presence.set(state);
  };
  const moveCursor = (at: CursorPoint | null) => {
    shownCursor = at;
    if (active()) presence.moveCursor(at);
  };
  createEffect(on(active, (shown) => {
    presence.set(shown ? shownState : null);
    presence.moveCursor(shown ? shownCursor : null);
    if (!shown && sidePanel()?.key?.startsWith(panelPrefix)) setSidePanel(null);
  }, { defer: true }));
  onCleanup(() => {
    presence.set(null);
    presence.moveCursor(null);
  });
  const userOf = (id: number) => member(props.workspaceId, id);
  const cursorsOf = () => presence.cursorUsers().flatMap((userId) => {
    const at = presence.cursorOf(userId);
    return at ? [{ userId, ...at }] : [];
  });
  const drawCursors = (element: HTMLElement, toScreen: (at: CursorPoint) => CursorPoint) => {
    const [tick, setTick] = createSignal(0);
    const layer = document.createElement("div");
    layer.className = "remote-cursors";
    element.append(layer);
    const dispose = render(() => (
      <RemoteCursors others={cursorsOf} user={userOf} toScreen={(at) => { tick(); return toScreen(at); }} />
    ), layer);
    return {
      redraw: () => setTick((n) => n + 1),
      remove: () => {
        dispose();
        layer.remove();
      },
    };
  };

  const context = (): ChannelContext => {
    const workspace = { id: props.workspaceId, name: workspaces.byId[props.workspaceId]?.info.name ?? props.workspaceId };
    return {
    workspace,
    get server() { return workspace; },
    channel: {
      id: props.channel.id, name: props.channel.name, type: props.channel.type,
      category: findCategory(props.workspaceId, props.channel.categoryId)?.name ?? "",
    },
    user: { username: account()?.username ?? "", displayName: account()?.displayName ?? "" },
    users: { me: () => myId(props.workspaceId), get: (id) => member(props.workspaceId, id), list: () => memberListVisible(props.workspaceId),
      assignable: () => assignableMembers(props.workspaceId) },
    api: ext(),
    openSidePanel: (title, mount, key) =>
      setSidePanel({ title, render: () => <MountPoint mount={mount} />, key: key === undefined ? undefined : panelKey(key) }),
    toggleSidePanel: (key, title, mount) => toggleSidePanel({ title, render: () => <MountPoint mount={mount} />, key: panelKey(key) }),
    isSidePanelOpen: (key) => sidePanelShowing(panelKey(key)),
    closeSidePanel: () => setSidePanel(null),
    openFile,
    target: () => {
      const here = current();
      return here?.workspaceId === props.workspaceId && here.channelId === props.channel.id ? here.target ?? null : null;
    },
    linkTo: (target) => linkUrl({ workspaceId: props.workspaceId, channelId: props.channel.id, target }),
    openLink: (url) => void openLink(url),
    openContextMenu,
    openUserMenu: (event, userId) => openContextMenu(event, userMenu(props.workspaceId, userId)),
    playSound,
    history: historyFor(`${props.workspaceId}:${props.channel.id}`),
    active,
    presence: { set: setPresence, others: presence.others },
    hosting: canInChannel(props.workspaceId, props.channel.id, "manage_nodes") ? (url: string, size?: number | null) => {
      const hash = refHash(url);
      if (!hash) return null;
      return contentHosting(props.workspaceId, hash, size ?? null);
    } : undefined,
    cursors: {
      move: moveCursor,
      others: cursorsOf,
      draw: drawCursors,
    },
    streams: {
      share: (stream) => shareChannelStream(props.workspaceId, props.channel.id, stream),
      others: () => channelStreams(props.workspaceId, props.channel.id),
    },
    events: {
      send: (message, to) => sendChannelEvent(props.workspaceId, props.channel.id, message, to),
      listen: (handler) => onChannelEvent(props.workspaceId, props.channel.id, handler),
    },
    can: (permission) => isPermission(permission) && canInChannel(props.workspaceId, props.channel.id, permission),
    // A file of the plugin's own package; only installed plugins have one (built-ins answer null).
    asset: (path) => pluginAsset(pluginOfType(props.channel.type)?.plugin.manifest.id ?? "", path),
    setting: (key) => pluginSetting(pluginOfType(props.channel.type)?.plugin.manifest.id ?? "", key),
    secret: (key) => pluginSecret(pluginOfType(props.channel.type)?.plugin.manifest.id ?? "", key),
    };
  };

  const [remote] = createResource(() => !workspacePluginInactive() && !local() && !disabledPlugin() && props.channel.type, async (): Promise<Remote> => {
    const info = await ext().describe();
    if (!info) return { kind: "none" };
    if (info.functions.some((f) => f.name === "client-ui")) {
      const { html } = await ext().call<{ html?: unknown }>("client-ui");
      if (typeof html === "string") return { kind: "sandbox", html };
    }
    return { kind: "generic", info };
  });

  const sandboxHtml = () => {
    const r = remote();
    return r?.kind === "sandbox" ? r.html : undefined;
  };
  const describedInfo = () => {
    const r = remote();
    return r?.kind === "generic" ? r.info : undefined;
  };

  return (
    <div class="channel-host">
      <ChannelPluginNote workspaceId={props.workspaceId} channel={props.channel} workspacePlugin={workspacePlugin()} />
      <Switch>
        <Match when={forgotten()}>
          <ForgottenChannel workspaceId={props.workspaceId} channel={props.channel} />
        </Match>
        <Match when={workspacePlugin.error}>
          <p class="channel-host-note warning">{userMessage(workspacePlugin.error)}</p>
        </Match>
        <Match when={workspacePluginInactive()}>
          <div class="channel-plugin-banner">
            <span>The plugin is {workspacePlugin()?.status === "removed" ? "removed" : "disabled"} in this workspace.</span>
          </div>
        </Match>
        <Match when={!workspaceLoaded()}>
          <Skeleton kind={loaderFor(props.channel.type)} />
        </Match>
        <Match when={disabledPlugin()}>
          {(found) => (
            <div class="channel-plugin-banner">
              <span>The plugin "{found().plugin.manifest.name}" is disabled.</span>
              <button class="mw-button mw-box" onClick={() => setEnabled(found().plugin.manifest.id, true)}>Enable</button>
            </div>
          )}
        </Match>
        <Match when={local()}>
          {(found) => (
            <ErrorBoundary fallback={(e) => <PluginError name={found().plugin.name} error={e} />}>
              <PluginView view={found().view} context={context()} />
            </ErrorBoundary>
          )}
        </Match>
        <Match when={remote.error}>
          <p class="channel-host-note warning">{userMessage(remote.error)}</p>
        </Match>
        <Match when={remote.loading}>
          <Skeleton kind={loaderFor(props.channel.type)} />
        </Match>
        <Match when={sandboxHtml()}>
          {(html) => (
            <SandboxFrame html={html()} api={api()} plugin={props.channel.type}
              context={{ workspace: context().workspace, server: context().workspace, channel: context().channel, user: context().user }} />
          )}
        </Match>
        <Match when={describedInfo()}>{(info) => <GenericView ext={ext()} info={info()} />}</Match>
        <Match when={remote()?.kind === "none"}>{props.fallback}</Match>
      </Switch>
    </div>
  );
}

function PluginView(props: { view: ChannelView; context: ChannelContext }) {
  return <MountPoint mount={(element) => props.view(element, props.context)} />;
}


function PluginError(props: { name: string; error: unknown }) {
  console.error(`Plugin '${props.name}' failed:`, props.error);
  if (!import.meta.env.DEV) reportCrash(props.error, `the plugin "${props.name}"`);
  return (
    <div class="channel-host-note">
      <p class="warning">The plugin "{props.name}" could not show this channel.</p>
      <pre class="muted">{String(props.error instanceof Error ? props.error.message : props.error)}</pre>
    </div>
  );
}

// What to do about the channel's plugin before showing it: a disabled plugin can be turned back on, and a plugin
// no one here installed, or installed in another version, can be matched to the workspace's stored package.
function ChannelPluginNote(props: { workspaceId: string; channel: Channel; workspacePlugin?: WorkspacePlugin }) {
  const found = () => pluginOfType(props.channel.type);
  const mode = (): "install" | "update" | "newer" | undefined => {
    const wanted = props.workspacePlugin;
    const have = found();
    if (wanted?.status !== "enabled") return undefined;
    if (!have) return "install";
    if (have.origin !== "installed") return undefined;
    try {
      const order = comparePluginVersions(have.plugin.manifest.version, wanted.version);
      return order < 0 ? "update" : order > 0 ? "newer" : undefined;
    } catch {
      return have.plugin.manifest.version === wanted.version ? undefined : "update";
    }
  };
  return (
    <Show when={mode()}>
      {(m) => <InstallFromWorkspace workspaceId={props.workspaceId} channel={props.channel} workspacePlugin={props.workspacePlugin!} found={found()} mode={m()} />}
    </Show>
  );
}

// "Install plugin X (from this workspace)": the workspace's channels_plugins row has the package; it is fetched,
// its manifest read for the trust question, and only a positive answer installs it on this device. When this
// device has a newer version, it offers to go back to the workspace's version or, for members who manage plugins,
// to share the newer one with the workspace.
function InstallFromWorkspace(props: {
  workspaceId: string;
  channel: Channel;
  workspacePlugin: WorkspacePlugin;
  found?: ReturnType<typeof pluginOfType>;
  mode: "install" | "update" | "newer";
}) {
  const [info, setInfo] = createSignal<{ name: string; author: string; bytes: Uint8Array } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal("");
  const name = () => props.found?.plugin.manifest.name ?? props.workspacePlugin.id;
  const localVersion = () => props.found?.plugin.manifest.version ?? "";
  const action = () => props.mode === "install" ? "Install" : props.mode === "update" ? "Update" : "Downgrade";

  const begin = async () => {
    setBusy(true);
    setFailed("");
    try {
      const url = props.workspacePlugin.package;
      if (!refHash(url) || !(await ensureLocal(props.workspaceId, { kind: "channel", id: props.channel.id }, url)))
        throw new Error("The plugin's package is not available yet.");
      const bytes = new Uint8Array(await (await contentBlob(url, "application/zip")).arrayBuffer());
      setInfo({ ...packagePeek(bytes), bytes });
    } catch (e) {
      setFailed(e instanceof Error ? e.message : userMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    const i = info();
    if (!i) return;
    setBusy(true);
    setFailed("");
    try {
      if (props.mode === "install") await installPlugin(i.bytes);
      else await updatePlugin(props.workspacePlugin.id, i.bytes, { downgrade: props.mode === "newer" });
    } catch (e) {
      setFailed(e instanceof Error ? e.message : userMessage(e));
    } finally {
      setBusy(false);
      setInfo(null);
    }
  };
  const share = async () => {
    setBusy(true);
    setFailed("");
    try {
      const bytes = await pluginPackage(props.workspacePlugin.id);
      if (!bytes) throw new Error("This device doesn't have the plugin package.");
      await updateWorkspacePlugin(props.workspaceId, {
        plugin_id: props.workspacePlugin.id,
        version: props.workspacePlugin.version,
        manifest: props.workspacePlugin.manifest,
      }, bytes);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class="channel-plugin-banner">
        <span>{props.mode === "install"
          ? `Install plugin "${props.workspacePlugin.id}" from this workspace?`
          : props.mode === "update"
            ? `Update plugin "${name()}" to ${props.workspacePlugin.version} from this workspace?`
            : `This workspace uses "${name()}" ${props.workspacePlugin.version}; you have ${localVersion()}.`}</span>
        <button class="mw-button mw-box" disabled={busy()} onClick={() => void begin()}>
          {busy() ? "Working..." : props.mode === "newer" ? `Use ${props.workspacePlugin.version}` : action()}
        </button>
        <Show when={props.mode === "newer" && can(props.workspaceId, "manage_plugins")}>
          <button class="mw-button mw-box" disabled={busy()} onClick={() => void share()}>
            Update workspace to {localVersion()}
          </button>
        </Show>
        <Show when={failed()}><span class="warning">{failed()}</span></Show>
      </div>
      <Show when={info()}>
        {(i) => (
          <ConfirmPrompt
            open
            question={`${action()} "${i().name || props.workspacePlugin.id}"${props.mode === "install" ? "" : ` to ${props.workspacePlugin.version}`}${i().author ? ` by ${i().author}` : ""}? It runs with full access to your data.`}
            confirmLabel={action()}
            onConfirm={() => void install()}
            onCancel={() => setInfo(null)}
          />
        )}
      </Show>
    </>
  );
}

// The package's own manifest (manifest.json), so the trust question can name the plugin and its author.
function packagePeek(bytes: Uint8Array): { name: string; author: string } {
  try {
    const files = unzipSync(bytes);
    const parsed = JSON.parse(strFromU8(files["manifest.json"]));
    return {
      name: typeof parsed?.name === "string" ? parsed.name : "",
      author: typeof parsed?.author === "string" ? parsed.author : "",
    };
  } catch {
    return { name: "", author: "" };
  }
}
