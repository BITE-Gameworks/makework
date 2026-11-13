import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { EventType, Replayer, type eventWithTime } from "rrweb";
import { canInChannel } from "../../../core/workspaces";
import { desktop, browserPartitionFor, type BrowserVideo, type ProxiedResource } from "../../../core/desktop";
import { userMessage } from "../../../api/client";
import { render } from "solid-js/web";
import { Icon } from "../../../theme/icons";
import { ConfirmItem, RenameItem } from "../../../shell/channelMenu";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import RemoteCursors from "../../../ui/RemoteCursors";
import Select from "../../../ui/Select";
import Skeleton from "../../../ui/Skeleton";
import { relativeTime } from "../../../core/time";
import { motionMs } from "../../../ui/presence";
import type { ChannelContext } from "../../types";
import {
  addBookmark, clearHistory, clearPage, createBookmarks, createChannelExtensions, createExtensions, createHistory, removeBookmark, renameBookmark,
  restoreBookmark, savePage, storedPage,
  type Bookmark,
} from "./data";
import {
  addressFor, buttonOf, domChunkSize, electedHost, isBrowserMessage, browserProtocol, keyInput, maxDomChunks, maxResourceChunks, minPageHeight, modifiersOf,
  pageWidth, sharedShortcut, syncModes, wheel,
  type Anchor, type BrowserMessage, type BrowserPresence, type KeyInput, type PageInput, type SyncMode,
} from "./input";
import { captureElement, captureVideo, isVideoRegion, type VideoRegion, type VideoShare } from "./videoShare";
import { createRewriter, fromBase64, packDom, toBase64, unpackDom } from "./proxy";
import "./browser.css";

// The parts of Electron's <webview> used here.
interface Webview extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  setZoomFactor(factor: number): void;
  sendInputEvent(event: object): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  getWebContentsId(): number;
  setAudioMuted(muted: boolean): void;
}

const blank = "about:blank";
const saveAfterMs = 4000;
const followAfterMs = 400;

const sameUrl = (a: string, b: string) => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
};
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// The first playing or paused media with a length, for keeping videos in step between members.
// Also when someone last played, paused or seeked it on this copy: changes mediaApply makes are marked and don't count.
const mediaProbe = `(() => {
  const m = [...document.querySelectorAll("video, audio")].find((m) => m.duration > 0);
  if (!m) return null;
  if (!m.__mwActed) {
    m.__mwActed = 1;
    for (const type of ["play", "pause", "seeked"]) m.addEventListener(type, () => {
      const expected = m.__mwExpect?.[type];
      if (expected && Date.now() - expected < 5000) m.__mwExpect[type] = 0;
      else m.__mwActed = Date.now();
    });
  }
  return [m.paused, m.currentTime, m.__mwActed];
})()`;
type MediaState = [paused: boolean, time: number, actedAt: number];
const mediaPause = `document.querySelectorAll("video, audio").forEach((m) => m.pause())`;
const mediaPlay = `[...document.querySelectorAll("video, audio")].find((m) => m.duration > 0)?.play().catch(() => {})`;
const mediaApply = (paused: boolean, time: number) => `(() => {
  const m = [...document.querySelectorAll("video, audio")].find((m) => m.duration > 0);
  if (!m) return;
  const expect = (m.__mwExpect ??= {});
  if (Math.abs(m.currentTime - ${time}) > 1.5) {
    expect.seeked = Date.now();
    m.currentTime = ${time};
  }
  if (${paused} && !m.paused) {
    expect.pause = Date.now();
    m.pause();
  }
  if (${!paused} && m.paused) {
    expect.play = Date.now();
    m.play().catch(() => {});
  }
})()`;

export default function BrowserView(props: { context: ChannelContext }) {
  const ctx = props.context;
  if (!desktop) {
    return (
      <div class="view">
        <p class="view-note">Channel not available in the web app.</p>
      </div>
    );
  }

  function BrowserExtensionsPanel(props: { context: ChannelContext }) {
    const ctx = props.context;
    const extensions = createExtensions(ctx.api);
    const channelExtensions = createChannelExtensions(ctx.api, ctx.channel.id);
    const [source, setSource] = createSignal("");
    const [busy, setBusy] = createSignal("");
    const [error, setError] = createSignal("");
    const [removing, setRemoving] = createSignal("");
    const canManagePlugins = () => ctx.can("manage_plugins");
    const canManageChannel = () => ctx.can("manage_channels");
    const enabled = (id: string) => channelExtensions.value.find((row) => row.extensionId === id)?.enabled === true;
    const webStoreId = (value: string) => {
      const match = /(?:^|\/)([a-p]{32})(?:[/?#]|$)/.exec(value.trim().toLowerCase());
      return match?.[1] ?? (/^[a-p]{32}$/.test(value.trim()) ? value.trim() : null);
    };
    const install = async () => {
      const id = webStoreId(source());
      if (!id) return setError("Paste a Chrome Web Store URL or its 32-character extension id.");
      if (!desktop?.browserExtensions) return setError("Browser extensions are available in the desktop app.");
      setBusy(id);
      setError("");
      try {
        const extension = await desktop.browserExtensions.install(id);
        await ctx.api.call("install-extension", { extension_id: extension.id, name: extension.name, version: extension.version });
        setSource("");
      } catch (e) {
        setError(userMessage(e));
      } finally {
        setBusy("");
      }
    };
    const setEnabled = async (id: string, value: boolean) => {
      setBusy(id);
      setError("");
      try {
        await ctx.api.call("set-channel-extension", { channel_id: ctx.channel.id, extension_id: id, enabled: value });
      } catch (e) {
        setError(userMessage(e));
      } finally {
        setBusy("");
      }
    };
    const remove = async (id: string) => {
      setBusy(id);
      setError("");
      try {
        await ctx.api.call("remove-extension", { extension_id: id });
        setRemoving("");
      } catch (e) {
        setError(userMessage(e));
      } finally {
        setBusy("");
      }
    };

    return (
      <div class="browser-extensions-panel">
        <p class="hint">Extensions run with the permissions their Chrome Web Store listing requests. They are loaded only in browser channels where they are enabled.</p>
        <Show when={error()}><p class="warning">{error()}</p></Show>
        <Show when={canManagePlugins()}>
          <form class="browser-extension-add" onSubmit={(event) => { event.preventDefault(); void install(); }}>
            <input class="mw-input mw-box" value={source()} onInput={(event) => setSource(event.currentTarget.value)}
              placeholder="Chrome Web Store URL or extension id" aria-label="Chrome Web Store extension" />
            <button type="submit" class="mw-button mw-box" disabled={!!busy()}>{busy() ? "Installing..." : "Install"}</button>
          </form>
        </Show>
        <Show when={extensions.value.length} fallback={<p class="hint">No Chrome Web Store extensions are installed in this workspace.</p>}>
          <ul class="browser-extension-list">
            <For each={extensions.value}>
              {(extension) => (
                <li class="browser-extension-item mw-box">
                  <div>
                    <strong>{extension.name}</strong> <span class="muted">{extension.version}</span>
                    <p class="hint">{extension.extensionId}</p>
                  </div>
                  <Show when={canManageChannel()}>
                    <button class="mw-button mw-box" disabled={!!busy()} onClick={() => void setEnabled(extension.extensionId, !enabled(extension.extensionId))}>
                      {busy() === extension.extensionId ? "Saving..." : enabled(extension.extensionId) ? "Disable here" : "Enable here"}
                    </button>
                  </Show>
                  <Show when={canManagePlugins()}>
                    <button class="mw-button mw-box" disabled={!!busy()} onClick={() => setRemoving(extension.extensionId)}>Remove</button>
                    <Show when={removing() === extension.extensionId}>
                      <ConfirmPrompt open question={`Remove ${extension.name} from this workspace? It will be disabled in every browser channel.`}
                        confirmLabel="Remove" onConfirm={() => void remove(extension.extensionId)} onCancel={() => setRemoving("")} />
                    </Show>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={!canManagePlugins() && !canManageChannel()}>
          <p class="hint">You need Manage plugins to install extensions or Manage channels to enable them here.</p>
        </Show>
      </div>
    );
  }

  function BrowserHistoryPanel(props: { context: ChannelContext; open: (url: string) => void; canOpen: () => boolean }) {
    const ctx = props.context;
    const history = createHistory(ctx.api, ctx.channel.id);
    const [clearing, setClearing] = createSignal(false);
    const [error, setError] = createSignal("");
    const clear = async () => {
      setClearing(false);
      try {
        await clearHistory(ctx.api, ctx.channel.id);
      } catch (e) {
        setError(userMessage(e));
      }
    };
    return (
      <div class="browser-history-panel">
        <Show when={error()}><p class="warning">{error()}</p></Show>
        <Show when={history.loaded} fallback={<Skeleton kind="line" />}>
          <Show when={history.value.length} fallback={<p class="hint mw-fade-in">No pages visited yet.</p>}>
            <Show when={ctx.can("edit_content")}>
              <button class="mw-button mw-box" onClick={() => setClearing(true)}><Icon name="delete" /> Clear history</button>
              <ConfirmPrompt open={clearing()} question="Clear this channel's history for everyone?" confirmLabel="Clear"
                onConfirm={() => void clear()} onCancel={() => setClearing(false)} />
            </Show>
            <ul class="browser-history-list mw-fade-in">
              <For each={history.value}>
                {(visit) => (
                  <li>
                    <button class="browser-history-item mw-box" title={visit.url} disabled={!props.canOpen()} onClick={() => props.open(visit.url)}>
                      <span class="browser-history-title">{visit.title || hostOf(visit.url)}</span>
                      <span class="hint">{hostOf(visit.url)} · {ctx.users.get(visit.authorId).displayName} · {relativeTime(visit.visitedAt)}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    );
  }

  const me = () => ctx.users.me();
  const canDrive = () => ctx.can("edit_content");
  const bookmarks = createBookmarks(ctx.api, ctx.channel.id);
  const extensions = createExtensions(ctx.api);
  const channelExtensions = createChannelExtensions(ctx.api, ctx.channel.id);
  const partition = browserPartitionFor(ctx.workspace.id, ctx.channel.id);
  const enabledExtensionIds = () => {
    const enabled = new Set(channelExtensions.value.filter((row) => row.enabled).map((row) => row.extensionId));
    return extensions.value.filter((extension) => enabled.has(extension.extensionId)).map((extension) => extension.extensionId);
  };
  const [extensionError, setExtensionError] = createSignal("");
  const [url, setUrl] = createSignal(blank);
  const [title, setTitle] = createSignal("");
  const [address, setAddress] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [canBack, setCanBack] = createSignal(false);
  const [canForward, setCanForward] = createSignal(false);
  const [scale, setScale] = createSignal(1);
  const [frameHeight, setFrameHeight] = createSignal(0);
  const [clicks, setClicks] = createSignal<{ id: number; x: number; y: number; userId: number }[]>([]);
  const [syncMode, setSyncMode] = createSignal<SyncMode>("mirror");
  const [videoRegion, setVideoRegion] = createSignal<VideoRegion | null>(null);

  let stage!: HTMLDivElement;
  let frame!: HTMLDivElement;
  let overlay!: HTMLDivElement;
  let mirror!: HTMLDivElement;
  let view: Webview | undefined;
  let ready = false;
  // Who acted last. Only that member's page is followed for navigation, scrolling and media.
  let driver: number | null = null;
  // When this member last took control; a signal, so the view switches between page and mirror at once.
  const [ownHostAt, setOwnHostAt] = createSignal<number | null>(null);
  const peers = () => ctx.presence.others().map((peer) => ({ userId: peer.userId, state: peer.state as BrowserPresence }));
  // Members who can't drive never host: they couldn't navigate, and the others drop their snapshots.
  const host = () => electedHost(canDrive() ? me() : null, [
    ...peers().filter((p) => canInChannel(ctx.workspace.id, ctx.channel.id, "edit_content", p.userId)),
    ...(ownHostAt() === null || me() === null ? [] : [{ userId: me()!, state: { host: true as const, hostAt: ownHostAt()! } }]),
  ]);
  const hosting = () => syncMode() !== "mirror" || host() === me();
  const driving = () => syncMode() === "mirror" ? hosting() : driver !== null && driver === me();
  const canControl = () => canDrive() && hosting();

  const run = (code: string, gesture = false) => (ready && view ? view.executeJavaScript(code, gesture).catch(() => null) : Promise.resolve(null));
  const share = (message: BrowserMessage, to?: number) => ctx.events.send({ ...message, v: browserProtocol }, to);
  // When this member last did something; an address another member sends just after is older than that.
  let actedAt = 0;
  const [otherVersions, setOtherVersions] = createSignal<number[]>([]);
  // Set from the moment the view opens: channel events only reach members with presence in the channel, so a member
  // who hadn't navigated yet got no mirror, clicks or pages.
  const sharePresence = () => {
    const at = ownHostAt();
    const video = videoRegion();
    ctx.presence.set({
      v: browserProtocol, mode: syncMode(), ...(url() === blank ? {} : { url: url() }), ...(at === null ? {} : { host: true, hostAt: at }),
      ...(video ? { video } : {}),
    });
  };
  createEffect(on([syncMode, videoRegion], sharePresence, { defer: true }));
  // Everyone in the channel is in one mode: a member who opens it takes the one the others are in, and a choice goes
  // to all.
  let modeChosen = false;
  const chooseMode = (mode: SyncMode) => {
    modeChosen = true;
    setSyncMode(mode);
    share({ t: "mode", mode });
  };
  createEffect(() => {
    if (modeChosen) return;
    const theirs = [...peers()].sort((a, b) => Number(b.userId === host()) - Number(a.userId === host()))
      .map((p) => p.state.mode).find((m): m is SyncMode => syncModes.includes(m as SyncMode));
    if (!theirs) return;
    modeChosen = true;
    setSyncMode(theirs);
  });
  const announceHost = () => {
    if (!canDrive() || me() === null) return;
    const at = Date.now();
    setOwnHostAt(at);
    driver = me();
    actedAt = at;
    sharePresence();
    share({ t: "host", at });
  };
  // Taking over a mirror: this member's own page wasn't following, so it opens the page the host has first.
  const takeControl = () => {
    const theirs = peers().find((p) => p.userId === host())?.state.url;
    announceHost();
    if (typeof theirs === "string" && /^https?:/i.test(theirs) && !sameUrl(theirs, view?.getURL() ?? "")) load(theirs);
  };
  let domBatchId = 0;
  // Packing is async; the chain keeps batches in the order the page made them, on both ends.
  let domSending = Promise.resolve();
  const sendDomEvents = (events: unknown[]) => {
    domSending = domSending.then(async () => {
      const data = await packDom(events);
      const id = domBatchId++;
      const total = Math.ceil(data.length / domChunkSize);
      if (!total || total > maxDomChunks) return;
      for (let index = 0; index < total; index++)
        share({ t: "dom", id, index, total, data: data.slice(index * domChunkSize, (index + 1) * domChunkSize) });
    }).catch(() => {});
  };
  let domReceiving = Promise.resolve();
  const domParts = new Map<number, { total: number; parts: string[] }>();
  let replayer: Replayer | undefined;
  // A viewer asks again until a snapshot comes (a few times per host): the first ask can reach the host before this
  // member's presence does, and the host's snapshot then goes to everyone but them.
  let mirrored = false;
  let asks = 0;
  createEffect(on(host, () => {
    mirrored = false;
    asks = 0;
  }));
  const askTimer = setInterval(() => {
    if (syncMode() !== "mirror" || hosting() || mirrored || !ctx.active() || host() === null || asks >= 5) return;
    asks++;
    share({ t: "dom-need" });
  }, 3000);
  onCleanup(() => clearInterval(askTimer));
  // The resource proxy (proxy.ts): the mirror loads images and stylesheet resources through mwbrowser://, which asks
  // the host for what this member's own connection can't load.
  const proxyToken = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const proxied = createRewriter(desktop.browserProxy ? proxyToken : null);
  let resourceId = 0;
  const resourceWaits = new Map<number, { parts: string[]; total: number; finish: (answer: ProxiedResource | null) => void }>();
  const askHost = (url: string) => new Promise<ProxiedResource | null>((resolve) => {
    const from = host();
    if (from === null || from === me()) return resolve(null);
    const id = ++resourceId;
    const timer = setTimeout(() => finish(null), 15000);
    const finish = (answer: ProxiedResource | null) => {
      clearTimeout(timer);
      resourceWaits.delete(id);
      resolve(answer);
    };
    resourceWaits.set(id, { parts: [], total: 0, finish });
    share({ t: "res-need", id, url }, from);
  });
  const serveResource = async (userId: number, id: number, url: string) => {
    const found = syncMode() === "mirror" && hosting() && ready && view ? await desktop?.browserFetch?.(view.getWebContentsId(), url) : null;
    const data = found ? toBase64(found.body) : "";
    const total = Math.max(1, Math.ceil(data.length / domChunkSize));
    if (!found || total > maxResourceChunks) return share({ t: "res", id, index: 0, total: 1, status: 0, type: "", data: "" }, userId);
    for (let index = 0; index < total; index++) {
      share({ t: "res", id, index, total, status: found.status, type: found.type, data: data.slice(index * domChunkSize, (index + 1) * domChunkSize) }, userId);
    }
  };
  if (desktop.browserProxy) {
    const proxy = desktop.browserProxy;
    void proxy.register(proxyToken, partition);
    const stop = proxy.listen((id, token, url) => {
      if (token === proxyToken) void askHost(url).then((answer) => proxy.answer(id, answer));
    });
    onCleanup(() => {
      stop();
      void proxy.unregister(proxyToken);
      for (const wait of resourceWaits.values()) wait.finish(null);
    });
  }
  const replayDomEvents = (events: eventWithTime[]) => {
    proxied(events);
    const snapshot = events.some((event) => event.type === EventType.FullSnapshot);
    if (snapshot) {
      mirrored = true;
      replayer?.destroy();
      mirror.replaceChildren();
      replayer = new Replayer(events, { root: mirror, liveMode: true, mouseTail: false, showWarning: false });
      // Played by the host's clock from the snapshot on, so a clock that differs between the two doesn't delay it.
      replayer.startLive(events[0].timestamp - 200);
    } else {
      events.forEach((event) => replayer?.addEvent(event));
    }
    layoutChanged();
  };

  // Pointers go by the element under them (input.ts `Anchor`): a watcher's mirror is as tall as their own view and
  // its fonts and images may differ, so the same x and y can be over different things on the host's page.
  type Point = { x: number; y: number };
  const watching = () => syncMode() === "mirror" && !hosting();
  const recordingHere = () => syncMode() === "mirror" && hosting() && ready && !!view;
  const [layoutTick, setLayoutTick] = createSignal(0);
  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  const layoutChanged = () => {
    tickTimer ??= setTimeout(() => {
      tickTimer = undefined;
      setLayoutTick((n) => n + 1);
    }, 50);
  };
  onCleanup(() => clearTimeout(tickTimer));
  const mirrorAnchor = (p: Point): Anchor | undefined => {
    const el = mirror.querySelector("iframe")?.contentDocument?.elementFromPoint(p.x, p.y);
    const id = el && replayer ? replayer.getMirror().getId(el) : -1;
    if (!el || id <= 0) return undefined;
    const box = el.getBoundingClientRect();
    return box.width && box.height ? { id, fx: (p.x - box.left) / box.width, fy: (p.y - box.top) / box.height } : undefined;
  };
  const mirrorPoint = (a: Anchor): Point | null => {
    const el = replayer?.getMirror().getNode(a.id) as Element | null | undefined;
    if (el?.nodeType !== 1 || !el.isConnected) return null;
    const box = el.getBoundingClientRect();
    return box.width || box.height ? { x: box.left + a.fx * box.width, y: box.top + a.fy * box.height } : null;
  };
  const anchorsAt = async (points: Point[]): Promise<(Anchor | undefined)[]> => {
    if (watching()) return points.map(mirrorAnchor);
    if (!recordingHere() || !desktop?.browserAnchors) return points.map(() => undefined);
    const found = await desktop.browserAnchors(view!.getWebContentsId(), "at", points).catch(() => []);
    return points.map((_, i) => found[i] ?? undefined);
  };
  const pointsOf = async (anchors: Anchor[]): Promise<(Point | null)[]> => {
    if (watching()) return anchors.map(mirrorPoint);
    if (!recordingHere() || !desktop?.browserAnchors) return anchors.map(() => null);
    const found = await desktop.browserAnchors(view!.getWebContentsId(), "point", anchors).catch(() => []);
    return anchors.map((_, i) => found[i] ?? null);
  };
  const anchorOf = (e: PageInput): Anchor | undefined => ("x" in e ? e.at : undefined);
  // Only clicks go by element: hovering and dragging by element jumped at element edges where the layouts differ a
  // little, so the host's page saw the pointer leave and come back. The scroll is mirrored, so plain x and y match.
  const anchored = async (events: PageInput[]): Promise<PageInput[]> => {
    const mice = events.some((e) => e.type === "mouseDown" || e.type === "mouseUp") ? events.filter((e) => "x" in e) : [];
    if (!mice.length) return events;
    const found = await anchorsAt(mice.map((e) => ({ x: (e as Point).x, y: (e as Point).y })));
    const by = new Map<PageInput, Anchor | undefined>(mice.map((e, i) => [e, found[i]]));
    return events.map((e) => (by.get(e) ? { ...e, at: by.get(e) } as PageInput : e));
  };
  const placed = async (events: PageInput[]): Promise<PageInput[]> => {
    const withAnchor = events.filter((e) => anchorOf(e));
    if (!withAnchor.length) return events;
    const points = await pointsOf(withAnchor.map((e) => anchorOf(e)!));
    const by = new Map(withAnchor.map((e, i) => [e, points[i]]));
    return events.map((e) => {
      const p = by.get(e);
      return p ? { ...e, x: p.x, y: p.y } as PageInput : e;
    });
  };
  // Async lookups, so input goes through chains that keep its order.
  let inputSending = Promise.resolve();
  const shareInput = (events: PageInput[]) => {
    inputSending = inputSending.then(async () => share({ t: "input", events: await anchored(events) })).catch(() => {});
  };
  let inputPlaying = Promise.resolve();
  let cursorTurn = 0;
  const moveCursor = (p: Point | null) => {
    const turn = ++cursorTurn;
    if (!p || syncMode() !== "mirror") return ctx.cursors.move(p);
    void anchorsAt([p]).then(([anchor]) => turn === cursorTurn && ctx.cursors.move(anchor ? { ...p, anchor } : p));
  };
  // The others' pointers where their elements are here: in the mirror at once, on the host's page once its
  // preload answers. Placed again whenever the page changes (scrolling included).
  const [hostPlaced, setHostPlaced] = createSignal(new Map<number, Point>());
  let placeTurn = 0;
  createEffect(() => {
    layoutTick();
    const list = ctx.cursors.others().filter((c) => c.anchor);
    const turn = ++placeTurn;
    if (!recordingHere() || !list.length) return void setHostPlaced(new Map());
    void pointsOf(list.map((c) => c.anchor!)).then((points) => {
      if (turn === placeTurn) setHostPlaced(new Map(list.flatMap((c, i) => (points[i] ? [[c.userId, points[i]!] as const] : []))));
    });
  });
  const shownCursors = () => {
    layoutTick();
    const list = ctx.cursors.others();
    if (syncMode() !== "mirror") return list;
    if (watching()) return list.map((c) => ({ ...c, ...(c.anchor ? mirrorPoint(c.anchor) : null) }));
    const here = hostPlaced();
    return list.map((c) => ({ ...c, ...here.get(c.userId) }));
  };

  // The host streams the video on its page (videoShare.ts) while someone watches; watchers lay it over the same
  // element in their mirror.
  let videoAt: BrowserVideo | null = null;
  let videoShare: VideoShare | null = null;
  let videoStarting = false;
  let videoChecking = false;
  let videoMissing = 0;
  const stopVideo = () => {
    videoShare?.stop();
    videoShare = null;
    videoAt = null;
    ctx.streams.share(null);
    setVideoRegion(null);
  };
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const checkVideo = async () => {
    const id = ready && view ? view.getWebContentsId() : null;
    if (!recordingHere() || id === null || !ctx.active() || !ctx.presence.others().length) {
      if (videoShare) stopVideo();
      return;
    }
    if (videoChecking) return;
    videoChecking = true;
    const [found] = await (desktop?.browserAnchors?.(id, "media", []) ?? Promise.resolve([])).catch(() => []);
    videoChecking = false;
    if (!found) {
      if (videoShare && ++videoMissing > 3) stopVideo();
      return;
    }
    videoMissing = 0;
    videoAt = found;
    // The page went on to another video element: its own stream follows that one.
    if (videoShare?.nodeId !== undefined && videoShare.nodeId !== found.id) stopVideo();
    const whole = videoShare?.nodeId === found.id;
    const region: VideoRegion = whole
      ? { id: found.id, fx0: 0, fy0: 0, fx1: 1, fy1: 1, whole: true }
      : { id: found.id, fx0: round(found.fx0), fy0: round(found.fy0), fx1: round(found.fx1), fy1: round(found.fy1) };
    const was = videoRegion();
    if (!was || Object.entries(region).some(([k, v]) => was[k as keyof VideoRegion] !== v)) setVideoRegion(region);
    if (videoShare || videoStarting || !found.playing) return;
    videoStarting = true;
    try {
      videoShare = await captureElement(id, found.id) ?? await captureVideo(id, () => videoAt);
      if (videoShare) {
        console.info(`Shared browser: streaming the video ${videoShare.nodeId === undefined ? "as a cut-out of the page" : "element"}`);
        ctx.streams.share(videoShare.stream);
      }
    } catch (e) {
      console.warn("Shared browser: video capture unavailable", e);
    } finally {
      videoStarting = false;
    }
    if (videoShare && !recordingHere()) stopVideo();
  };
  const videoTimer = setInterval(() => void checkVideo(), 200);
  // The crop follows the page at once while it scrolls.
  createEffect(on(layoutTick, () => videoShare && void checkVideo(), { defer: true }));
  onCleanup(() => {
    clearInterval(videoTimer);
    stopVideo();
  });
  const hostStream = () => (watching() ? ctx.streams.others().find((s) => s.userId === host())?.stream ?? null : null);
  const videoBox = createMemo(() => {
    layoutTick();
    const v = peers().find((p) => p.userId === host())?.state.video;
    if (!isVideoRegion(v) || !hostStream()) return null;
    const whole = (v as VideoRegion).whole === true;
    const el = replayer?.getMirror().getNode(v.id) as Element | null | undefined;
    if (el?.nodeType !== 1 || !el.isConnected) return null;
    const b = el.getBoundingClientRect();
    const k = scale();
    return { x: (b.left + v.fx0 * b.width) * k, y: (b.top + v.fy0 * b.height) * k, w: (v.fx1 - v.fx0) * b.width * k, h: (v.fy1 - v.fy0) * b.height * k, whole };
  });
  let videoOut!: HTMLVideoElement;
  createEffect(() => {
    const stream = hostStream();
    if (videoOut.srcObject !== stream) videoOut.srcObject = stream;
    if (stream) void videoOut.play().catch(() => {});
  });
  const applyExtensions = async () => {
    const extensionBridge = desktop?.browserExtensions;
    if (!extensionBridge || !extensions.loaded || !channelExtensions.loaded) return;
    try {
      const ids = enabledExtensionIds();
      try {
        await extensionBridge.apply(partition, ids);
      } catch (e) {
        if (!String((e as Error).message).includes("not installed locally")) throw e;
        await Promise.all(ids.map((id) => extensionBridge.install(id)));
        await extensionBridge.apply(partition, ids);
      }
      setExtensionError("");
      if (ready && url() !== blank) view?.reload();
    } catch (e) {
      setExtensionError(userMessage(e));
    }
  };
  createEffect(() => {
    // Read only so the effect runs again when either list changes.
    void extensions.value;
    void channelExtensions.value;
    void applyExtensions();
  });

  // A click sent to the page gives it the window's focus. It goes back at once: to the input layer after this
  // member's click (their keys go through it), to wherever they were (chat, address bar) after someone else's.
  // A newer click of this member's own cancels a hand-back still waiting.
  let focusTurn = 0;
  const keepFocus = (before: Element | null) => {
    if (before === view) return;
    const turn = focusTurn;
    const restore = () => {
      if (!view || turn !== focusTurn || document.activeElement !== view) return;
      if (before instanceof HTMLElement && before.isConnected && before !== document.body) before.focus();
      else view.blur();
    };
    // The page takes the focus a moment after the click reaches it.
    for (const ms of [0, 50, 150, 400]) setTimeout(restore, ms);
  };

  const apply = (events: PageInput[], remote: boolean) => {
    if (!ready || !view) return;
    const s = scale();
    const keys: KeyInput[] = [];
    for (const e of events) {
      if (e.type === "mouseWheel") view.sendInputEvent({ ...e, x: e.x * s, y: e.y * s, deltaX: e.deltaX * s, deltaY: e.deltaY * s, canScroll: true });
      else if ("x" in e) {
        const before = document.activeElement;
        view.sendInputEvent({ ...e, x: e.x * s, y: e.y * s });
        if (e.type === "mouseDown") keepFocus(remote ? before : overlay);
      } else keys.push(e);
    }
    if (keys.length) playKeys(keys);
  };
  const playKeys = (keys: (KeyInput | { type: "copy" })[]) => {
    if (ready && view) void desktop?.browserKeys?.(view.getWebContentsId(), keys).catch(() => {});
  };

  // A hidden kept view follows the page but stays quiet: muted, its videos paused. Shown again, it catches up with
  // the others' video (the latest they sent, else whoever drives answers), or plays on where it was if it played.
  const quiet = () => {
    try {
      view?.setAudioMuted(!ctx.active());
    } catch {
      // Not attached yet; dom-ready sets it.
    }
  };
  let missedMedia: { paused: boolean; time: number; at: number } | null = null;
  let playedWhenHidden = false;
  createEffect(on(ctx.active, (shown) => {
    quiet();
    if (!shown) {
      mirrored = false;
      asks = 0;
      missedMedia = null;
      void run(mediaProbe).then((state) => {
        playedWhenHidden = !!state && !(state as [boolean, number])[0];
        return run(mediaPause);
      });
      return;
    }
    const missed = missedMedia;
    missedMedia = null;
    if (missed) void run(mediaApply(missed.paused, missed.time + (missed.paused ? 0 : (Date.now() - missed.at) / 1000)), true);
    else if (playedWhenHidden) void run(mediaPlay, true);
    share({ t: "catchup" });
  }, { defer: true }));

  const load = (target: string) => {
    view?.loadURL(target).catch(() => {});
  };
  const go = (target: string) => {
    announceHost();
    setAddress(null);
    share({ t: "go", url: target });
    load(target);
  };
  // Closing the page takes every member's copy back to the empty view; it stays closed until someone opens a page.
  let closed = false;
  const closeHere = () => {
    closed = true;
    clearTimeout(saveTimer);
    clearTimeout(followTimer);
    replayer?.destroy();
    replayer = undefined;
    mirror.replaceChildren();
    setUrl(blank);
    setTitle("");
    sharePresence();
    load(blank);
  };
  const closePage = () => {
    announceHost();
    share({ t: "close" });
    closeHere();
    void clearPage(ctx.api, ctx.channel.id).catch(() => {});
  };
  const navigate = (kind: "back" | "forward" | "reload") => {
    announceHost();
    share({ t: kind });
    if (kind === "back") view?.goBack();
    else if (kind === "forward") view?.goForward();
    else view?.reload();
  };

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (driving() && canDrive() && /^https?:/i.test(url())) void savePage(ctx.api, ctx.channel.id, url(), title()).catch(() => {});
    }, saveAfterMs);
  };

  const navigated = (to: string) => {
    if (!view) return;
    // A page this copy began loading before it knew it only watches (the others' presence comes a moment later)
    // would run on under the mirror.
    if (watching() && to !== blank) return load(blank);
    mediaSeen = false;
    setUrl(to);
    setTitle(view.getTitle());
    setCanBack(view.canGoBack());
    setCanForward(view.canGoForward());
    view.setZoomFactor(scale());
    sharePresence();
    if (!/^https?:/i.test(to)) return;
    closed = false;
    if (driving()) {
      share({ t: "go", url: to });
      scheduleSave();
    }
  };

  // A member who opens the channel joins the page the others are on, else the one last saved.
  // Members found only after that (connections take a few seconds) are followed too: once, in the first seconds
  // and only while nobody acted, so two members who open it together can't keep swapping pages.
  const othersPage = () => ctx.presence.others().map((o) => (o.state as { url?: unknown } | null)?.url)
    .find((u): u is string => typeof u === "string" && /^https?:/i.test(u));
  const start = async () => {
    if (closed) return;
    const target = othersPage() ?? (await storedPage(ctx.api, ctx.channel.id).catch(() => null));
    if (target && url() === blank) load(target);
  };
  const openedAt = Date.now();
  let followed = false;
  createEffect(() => {
    const theirs = othersPage();
    if (!ready || !theirs || followed || closed || driver !== null || Date.now() - openedAt > 15000) return;
    if (syncMode() === "mirror" && !hosting()) return;
    followed = true;
    if (!sameUrl(theirs, view?.getURL() ?? "")) load(theirs);
  });
  createEffect(() => {
    if (ready && hosting() && url() === blank) void start();
  });

  const fit = () => {
    const style = getComputedStyle(stage);
    const width = stage.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    const height = stage.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
    const s = Math.min(width / pageWidth, height / minPageHeight) || 1;
    setScale(s);
    setFrameHeight(height);
    if (ready) view?.setZoomFactor(s);
  };

  onMount(() => {
    sharePresence();
    const page = document.createElement("webview") as Webview;
    page.setAttribute("partition", partition);
    page.setAttribute("src", blank);
    page.className = "browser-page";
    frame.prepend(page);
    view = page;
    page.addEventListener("dom-ready", () => {
      const first = !ready;
      ready = true;
      page.setZoomFactor(scale());
      quiet();
      checkAdblock();
      if (first && hosting()) void start();
      if (hosting() && syncMode() === "mirror") void desktop?.browserDomStart?.(page.getWebContentsId());
    });
    // Chromium keeps zoom per site, so a page from another site would first lay out at full width.
    page.addEventListener("load-commit", (e) => (e as Event & { isMainFrame: boolean }).isMainFrame && page.setZoomFactor(scale()));
    page.addEventListener("did-navigate", (e) => navigated((e as Event & { url: string }).url));
    page.addEventListener("did-navigate-in-page", (e) => {
      const event = e as Event & { url: string; isMainFrame: boolean };
      if (event.isMainFrame) navigated(event.url);
    });
    page.addEventListener("page-title-updated", (e) => {
      setTitle((e as Event & { title: string }).title);
      if (driving()) scheduleSave();
    });
    page.addEventListener("did-start-loading", () => setLoading(true));
    page.addEventListener("did-stop-loading", () => setLoading(false));

    const resize = new ResizeObserver(fit);
    resize.observe(stage);
    onCleanup(() => resize.disconnect());
    const stopDomListen = desktop?.browserDomListen?.((guestId, events) => {
      if (!hosting() || guestId !== page.getWebContentsId() || !Array.isArray(events)) return;
      sendDomEvents(events);
      layoutChanged();
    });
    onCleanup(() => {
      stopDomListen?.();
      void desktop?.browserDomStop?.(page.getWebContentsId());
    });
  });

  // Others' clicks, keys and navigation, from members who may edit the channel.
  let followTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(ctx.events.listen((userId, message) => {
    if ((message as { v?: unknown } | null)?.v !== browserProtocol) {
      if (!otherVersions().includes(userId)) setOtherVersions([...otherVersions(), userId]);
      return;
    }
    if (!isBrowserMessage(message)) return;
    // Asking for the mirror or a resource needs no edit permission: anyone in the channel sees the page.
    if (message.t === "res-need") return void serveResource(userId, message.id, message.url);
    if (message.t === "res") {
      const wait = resourceWaits.get(message.id);
      if (!wait || userId !== host() || (wait.total && wait.total !== message.total)) return;
      wait.total = message.total;
      wait.parts[message.index] = message.data;
      if (wait.parts.filter((part) => part !== undefined).length !== wait.total) return;
      try {
        wait.finish(message.status ? { status: message.status, type: message.type, body: fromBase64(wait.parts.join("")) } : null);
      } catch {
        wait.finish(null);
      }
      return;
    }
    if (message.t !== "dom-need" && !canInChannel(ctx.workspace.id, ctx.channel.id, "edit_content", userId)) return;
    if (message.t === "host") {
      driver = userId;
      return;
    }
    if (message.t === "go" && Date.now() - actedAt < followAfterMs * 4) return;
    if (!["scroll", "media", "catchup", "dom-need", "dom", "mode"].includes(message.t)) driver = userId;
    switch (message.t) {
      case "go":
        // Their click usually brings this page there too; load it only if it didn't.
        if (syncMode() === "mirror" && !hosting()) break;
        clearTimeout(followTimer);
        followTimer = setTimeout(() => !sameUrl(view?.getURL() ?? "", message.url) && load(message.url), followAfterMs);
        break;
      case "back": view?.goBack(); break;
      case "forward": view?.goForward(); break;
      case "reload": view?.reload(); break;
      case "close": closeHere(); break;
      case "mode":
        modeChosen = true;
        setSyncMode(message.mode);
        break;
      case "input":
        // Watching together, every member's clicks stay on their own copy.
        if (syncMode() === "together") break;
        inputPlaying = inputPlaying.then(async () => {
          const events = syncMode() === "mirror" ? await placed(message.events) : message.events;
          if (syncMode() === "individual" || hosting()) apply(events, true);
          for (const e of events) if (e.type === "mouseDown") ripple(e.x, e.y, userId);
        }).catch(() => {});
        break;
      case "dom-need":
        if (syncMode() === "mirror" && hosting() && view) {
          const hostView = view;
          void desktop?.browserDomStop?.(hostView.getWebContentsId()).then(() => desktop?.browserDomStart?.(hostView.getWebContentsId()));
        }
        break;
      case "dom": {
        if (syncMode() !== "mirror" || userId !== host()) break;
        const batch = domParts.get(message.id) ?? { total: message.total, parts: [] };
        if (batch.total !== message.total) break;
        batch.parts[message.index] = message.data;
        domParts.set(message.id, batch);
        if (batch.parts.filter(Boolean).length !== batch.total) break;
        domParts.delete(message.id);
        const packed = batch.parts.join("");
        domReceiving = domReceiving.then(async () => {
          const events = await unpackDom(packed) as eventWithTime[];
          if (Array.isArray(events) && syncMode() === "mirror" && !hosting()) replayDomEvents(events);
        }).catch(() => {
          // A missing or invalid chunk is discarded; the next host snapshot replaces it.
        });
        break;
      }
      case "scroll": void run(`scrollTo(${message.x}, ${message.y})`); break;
      case "media":
        if (syncMode() === "together") {
          // Whoever changed the video last keeps time for everyone, unless this member just did.
          if (!ctx.active()) break;
          void run(mediaProbe).then((state) => {
            const acted = (state as MediaState | null)?.[2] ?? 0;
            if (acted > 1 && Date.now() - acted < 1500) return;
            driver = userId;
            void run(mediaApply(message.paused, message.time), true);
          });
          break;
        }
        if (ctx.active()) void run(mediaApply(message.paused, message.time), true);
        else missedMedia = { paused: message.paused, time: message.time, at: Date.now() };
        break;
      case "catchup": {
        // One member watching answers: whoever drives if they are here, else the one with the lowest id. Members
        // with the view hidden hold back their presence, so presence lists who is watching.
        if (!ctx.active()) break;
        const watching = [me(), ...ctx.presence.others().map((o) => o.userId)]
          .filter((id): id is number => id !== null && id !== userId);
        const answers = driver !== null && watching.includes(driver) ? driver : Math.min(...watching);
        if (answers !== me()) break;
        void run(mediaProbe).then((state) => {
          if (state) share({ t: "media", paused: (state as [boolean, number])[0], time: (state as [boolean, number])[1] });
        });
        break;
      }
    }
  }));

  let rippleId = 0;
  const ripple = (x: number, y: number, userId: number) => {
    const id = ++rippleId;
    setClicks((list) => [...list, { id, x, y, userId }]);
    setTimeout(() => setClicks((list) => list.filter((c) => c.id !== id)), motionMs() * 3 + 200);
  };

  // After scrolling settles, the driver's scroll position, since pages scroll a little differently everywhere.
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleScrollSync = () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(async () => {
      const at = await run("[scrollX, scrollY]") as [number, number] | null;
      if (at && driving() && syncMode() !== "together") share({ t: "scroll", x: at[0], y: at[1] });
    }, 400);
  };

  // While this member drives, videos and sounds on the page are kept in step for the others. Watching together,
  // every member's own play, pause or seek counts: it makes them the one who keeps time, sent every few seconds so
  // copies that drift come back.
  let lastMedia: { paused: boolean; time: number; at: number } | null = null;
  let ownActedAt = 0;
  let mediaSentAt = 0;
  // A video that just appeared on this copy (the page loaded, the channel opened again) asks the others where theirs
  // is, else it would start from the beginning.
  let mediaSeen = false;
  const mediaTimer = setInterval(async () => {
    const together = syncMode() === "together";
    if (!ctx.active()) return void (lastMedia = null);
    if (syncMode() !== "mirror" && !mediaSeen && await run(mediaProbe) && !mediaSeen) {
      mediaSeen = true;
      if (!driving()) share({ t: "catchup" });
    }
    if (!together && !driving()) return void (lastMedia = null);
    const state = await run(mediaProbe) as MediaState | null;
    if (!state) return void (lastMedia = null);
    const [paused, time, acted] = state;
    const expected = lastMedia ? lastMedia.time + (lastMedia.paused ? 0 : (Date.now() - lastMedia.at) / 1000) : Number.NaN;
    const changed = lastMedia?.paused !== paused || Math.abs(time - expected) > 2;
    if (together) {
      const own = acted > ownActedAt && acted > 1;
      if (own) {
        ownActedAt = acted;
        driver = me();
      }
      if (driver === me() && (own || Date.now() - mediaSentAt > 3000)) {
        mediaSentAt = Date.now();
        share({ t: "media", paused, time });
      }
    } else if (changed) {
      share({ t: "media", paused, time });
    }
    lastMedia = { paused, time, at: Date.now() };
  }, 500);
  onCleanup(() => {
    clearInterval(mediaTimer);
    clearTimeout(saveTimer);
    clearTimeout(scrollTimer);
    clearTimeout(followTimer);
    replayer?.destroy();
  });

  // Only the host records; a member who hands over stops, and one who starts watching asks for a snapshot.
  createEffect(on(() => [syncMode(), hosting()] as const, ([mode, isHost]) => {
    if (mode === "mirror" && !isHost) share({ t: "dom-need" });
    if (!ready || !view) return;
    // A watcher's own page would keep running under the mirror.
    if (mode === "mirror" && !isHost && url() !== blank) load(blank);
    if (mode === "mirror" && isHost) void desktop?.browserDomStart?.(view.getWebContentsId());
    else void desktop?.browserDomStop?.(view.getWebContentsId());
  }));

  const pointAt = (e: MouseEvent) => {
    const r = overlay.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale(), y: (e.clientY - r.top) / scale() };
  };
  const mouse = (type: "mouseMove" | "mouseDown" | "mouseUp", e: MouseEvent, clickCount = 1): PageInput =>
    ({ type, ...pointAt(e), button: buttonOf(e.button), clickCount, modifiers: modifiersOf(e) });
  const act = (events: PageInput[], shared = true) => {
    if (!events.length) return;
    if (syncMode() === "mirror") {
      if (hosting()) apply(events, false);
      if (shared) shareInput(events);
      return;
    }
    driver = me();
    actedAt = Date.now();
    apply(events, false);
    if (shared && syncMode() === "individual") share({ t: "input", events });
  };



  let lastDown = { at: 0, x: 0, y: 0, count: 0 };
  const onPointerDown = (e: PointerEvent) => {
    if (!canDrive()) return;
    e.preventDefault();
    hover = null;
    focusTurn++;
    overlay.focus();
    overlay.setPointerCapture(e.pointerId);
    const p = pointAt(e);
    const again = Date.now() - lastDown.at < 400 && Math.hypot(p.x - lastDown.x, p.y - lastDown.y) < 5;
    lastDown = { at: Date.now(), ...p, count: again ? lastDown.count + 1 : 1 };
    act([mouse("mouseMove", e), mouse("mouseDown", e, lastDown.count)]);
  };
  // A watcher's hovering goes to the host's page too (a video's controls show on hover), at most every 50 ms.
  let hover: PageInput | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(hoverTimer));
  const shareHover = (move: PageInput) => {
    hover = move;
    hoverTimer ??= setTimeout(() => {
      hoverTimer = undefined;
      if (hover) act([hover]);
      hover = null;
    }, 50);
  };
  const onPointerMove = (e: PointerEvent) => {
    moveCursor(pointAt(e));
    if (!canDrive()) return;
    // Hovering stays on this member's page; moves with a button held (dragging, selecting text) are shared.
    if (e.buttons !== 0) act([mouse("mouseMove", e)]);
    else if (watching()) shareHover(mouse("mouseMove", e));
    else act([mouse("mouseMove", e)], false);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (canDrive()) act([mouse("mouseUp", e, lastDown.count)]);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!canDrive()) return;
    const turn = wheel({ deltaX: e.deltaX / scale(), deltaY: e.deltaY / scale(), deltaMode: e.deltaMode }, pointAt(e), modifiersOf(e));
    act([turn]);
    scheduleScrollSync();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!canDrive()) return;
    const shortcut = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // Pasting goes through the paste event, which has this member's clipboard text.
    if (shortcut && key === "v") return;
    if (shortcut && (key === "c" || key === "x")) {
      e.preventDefault();
      playKeys([{ type: "copy" }]);
      if (key === "x") act([{ type: "keyDown", key: "Backspace", code: "Backspace", modifiers: [] }]);
      return;
    }
    // Other shortcuts stay the app's (tabs, undo in the app).
    if (shortcut && !sharedShortcut(key)) return;
    e.preventDefault();
    const input = keyInput("keyDown", e);
    if (input) act([input]);
    scheduleScrollSync();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (!canDrive() || e.ctrlKey || e.metaKey) return;
    const input = keyInput("keyUp", e);
    if (input) act([input]);
  };
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain").slice(0, 10000) ?? "";
    if (canDrive() && text) act([{ type: "text", text }]);
  };

  const bookmarkHere = () => bookmarks.value.find((b) => sameUrl(b.url, url()));
  const toggleBookmark = async () => {
    const here = bookmarkHere();
    if (here) {
      await removeBookmark(ctx.api, here.id);
      ctx.history.push({ label: "Remove bookmark", icon: "star", undo: () => restoreBookmark(ctx.api, here.id), redo: () => removeBookmark(ctx.api, here.id) });
    } else if (/^https?:/i.test(url())) {
      const { id } = await addBookmark(ctx.api, ctx.channel.id, url(), title() || hostOf(url()));
      ctx.history.push({ label: "Add bookmark", icon: "star", undo: () => removeBookmark(ctx.api, id), redo: () => restoreBookmark(ctx.api, id) });
    }
  };
  const bookmarkMenu = (e: MouseEvent, b: Bookmark) => ctx.openContextMenu(e, [
    { label: "Open", icon: "globe", action: () => go(b.url), disabled: !canDrive() },
    ...(canDrive() ? [
      { render: () => <RenameItem label="Rename" value={b.title} clean={(t) => t.trim()} onSave={async (t) => void await renameBookmark(ctx.api, b.id, t)} /> },
      {
        render: () => (
          <ConfirmItem label="Delete bookmark" question={`Delete the bookmark ${b.title || hostOf(b.url)} for everyone?`}
            onConfirm={async () => {
              await removeBookmark(ctx.api, b.id);
              ctx.history.push({ label: "Remove bookmark", icon: "star", undo: () => restoreBookmark(ctx.api, b.id), redo: () => removeBookmark(ctx.api, b.id) });
            }} />
        ),
      },
    ] : []),
  ]);

  // Why this member's page may not match the others'.
  const [adblock, setAdblock] = createSignal("on");
  const checkAdblock = () => void desktop?.browserAdblock?.().then(setAdblock, () => {});
  const adblockTimer = setInterval(checkAdblock, 15000);
  onCleanup(() => clearInterval(adblockTimer));
  const versionOf = (state: unknown) => (state as { v?: unknown } | null)?.v;
  const notes = () => {
    const list: string[] = [];
    if (adblock().startsWith("off")) {
      list.push(`Ad blocking is off on this computer: ${adblock().slice(5)}. Your page may differ from the others'.`);
    }
    const others = new Set([
      ...otherVersions(),
      ...ctx.presence.others().filter((o) => (o.state as { url?: unknown } | null)?.url && versionOf(o.state) !== browserProtocol).map((o) => o.userId),
    ]);
    if (others.size) {
      const names = [...others].map((id) => ctx.users.get(id).displayName).join(", ");
      list.push(`${names} ${others.size === 1 ? "runs" : "run"} another version of MakeWork; the page won't stay in step until everyone updates.`);
    }
    return list;
  };

  // A viewer's own page doesn't follow the host's, so the address is the one the host shares.
  const pageUrl = () => {
    if (syncMode() !== "mirror" || hosting()) return url();
    const theirs = peers().find((p) => p.userId === host())?.state.url;
    return typeof theirs === "string" ? theirs : blank;
  };
  const shownAddress = () => address() ?? (pageUrl() === blank ? "" : pageUrl());

  return (
    <div class="view browser-view">
      <header class="view-header">
        <div class="view-tools mw-box">
          <button class="icon-button" title="Back" aria-label="Back" disabled={!canControl() || !canBack()} onClick={() => navigate("back")}>
            <Icon name="back" />
          </button>
          <button class="icon-button" title="Forward" aria-label="Forward" disabled={!canControl() || !canForward()} onClick={() => navigate("forward")}>
            <Icon name="forward" />
          </button>
          <button class="icon-button" title="Reload" aria-label="Reload" disabled={!canControl() || url() === blank} onClick={() => navigate("reload")}>
            <Icon name="refresh" />
          </button>
          <button class="icon-button" title="Close page" aria-label="Close page" disabled={!canControl() || url() === blank} onClick={closePage}>
            <Icon name="close" />
          </button>
        </div>
        <form class="browser-address" onSubmit={(e) => {
          e.preventDefault();
          const target = addressFor(shownAddress());
          if (target) go(target);
          e.currentTarget.querySelector("input")?.blur();
        }}>
          <input class="mw-input mw-box" value={shownAddress()} readOnly={!canControl()} spellcheck={false}
            placeholder={canControl() ? "Search or type an address" : "Take control to navigate"}
            aria-label="Address" classList={{ loading: loading() }}
            onFocus={(e) => {
              setAddress(shownAddress());
              e.currentTarget.select();
            }}
            onBlur={() => setAddress(null)}
            onInput={(e) => setAddress(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()} />
        </form>
        <div class="view-tools mw-box">
          <Select class="browser-sync-mode" label="Sync mode" value={syncMode()} options={[
            { value: "mirror", label: "Mirror one browser" },
            { value: "individual", label: "Each member loads the page" },
            { value: "together", label: "Watch together" },
          ]} onChange={(mode) => chooseMode(mode as SyncMode)} />
          <Show when={syncMode() === "mirror" && canDrive() && !hosting()}>
            <button class="icon-button" title="Take control" aria-label="Take control" onClick={takeControl}><Icon name="take-control" /></button>
          </Show>
          <button class="icon-button" classList={{ on: ctx.isSidePanelOpen("browser-history") }} title="History" aria-label="History" onClick={() =>
            ctx.toggleSidePanel("browser-history", "History", (element) =>
              render(() => <BrowserHistoryPanel context={ctx} open={go} canOpen={canControl} />, element))}>
            <Icon name="history" />
          </button>
          <button class="icon-button" classList={{ on: ctx.isSidePanelOpen("browser-extensions") }} title="Browser extensions" aria-label="Browser extensions" onClick={() =>
            ctx.toggleSidePanel("browser-extensions", "Browser extensions", (element) =>
              render(() => <BrowserExtensionsPanel context={ctx} />, element))}>
            <Icon name="admin" />
          </button>
          <button class="icon-button" classList={{ on: !!bookmarkHere() }} title={bookmarkHere() ? "Remove bookmark" : "Bookmark this page"}
            aria-label="Bookmark" disabled={!canControl() || url() === blank} onClick={() => void toggleBookmark()}>
            <Icon name="star" />
          </button>
        </div>
      </header>
      <Show when={notes().length}>
        <div class="browser-notes mw-fade-in">
          <For each={notes()}>{(note) => <p class="warning">{note}</p>}</For>
        </div>
      </Show>
      <Show when={extensionError()}>
        <div class="browser-notes mw-fade-in"><p class="warning">{extensionError()}</p></div>
      </Show>
      <Show when={bookmarks.value.length}>
        <nav class="browser-bookmarks mw-scroll-fade mw-fade-in" aria-label="Bookmarks">
          <For each={bookmarks.value}>
            {(b) => (
              <button class="browser-bookmark mw-box" title={b.url} disabled={!canControl()}
                onClick={() => go(b.url)} onContextMenu={(e) => bookmarkMenu(e, b)}>
                <Icon name="globe" /> <span>{b.title || hostOf(b.url)}</span>
              </button>
            )}
          </For>
        </nav>
      </Show>
      <div class="browser-stage" ref={stage}>
        <div class="browser-frame mw-box" ref={frame} style={{ width: `${pageWidth * scale()}px`, height: `${frameHeight()}px` }}>
          <div class="browser-mirror" ref={mirror} classList={{ showing: syncMode() === "mirror" && !hosting() }}
            style={{ "--scale": scale(), "--page-height": `${frameHeight() / scale()}px` }} />
          <video class="browser-video" ref={videoOut} autoplay playsinline muted={!ctx.active()} classList={{ showing: !!videoBox(), whole: !!videoBox()?.whole }}
            style={videoBox() ? { width: `${videoBox()!.w}px`, height: `${videoBox()!.h}px`, transform: `translate(${videoBox()!.x}px, ${videoBox()!.y}px)` } : {}} />
          <div class="browser-input" role="application" aria-label="Shared page" ref={overlay} tabindex="0" classList={{ watching: !canDrive() }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
            onPointerLeave={() => moveCursor(null)} onWheel={onWheel} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onPaste={onPaste}
            onContextMenu={(e) => e.preventDefault()} />
          <Show when={pageUrl() === blank}>
            <p class="browser-empty mw-fade-in">{canControl() ? "Search or type an address above. Everyone here sees the same page." : "Nothing is open yet."}</p>
          </Show>
          <div class="remote-cursors">
            <For each={clicks()}>
              {(c) => <span class="browser-click" style={{
                "--who": ctx.users.get(c.userId).color || "var(--mw-text-muted)",
                transform: `translate(${c.x * scale()}px, ${c.y * scale()}px)`,
              }} />}
            </For>
            <RemoteCursors others={shownCursors} user={ctx.users.get} toScreen={(p) => ({ x: p.x * scale(), y: p.y * scale() })} />
          </div>
        </div>
      </div>
    </div>
  );
}
