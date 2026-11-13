// One place to go anywhere: channels of every workspace, things inside the current workspace's channels (tasks, doc
// pages, files...), its messages (narrowed by in:channel and by:member) and commands. Opened by Ctrl+K in a dialog,
// and shown in place on a tab with nothing open.
import { For, Show, createEffect, createMemo, createResource, createSignal, on, type JSX } from "solid-js";
import { channelType } from "../core/channelTypes";
import { openLink, searchLinks } from "../core/links";
import { holdsWords, memberMatches, parseSearch, isEmptySearch } from "../core/searchQuery";
import { member, memberListVisible } from "../core/members";
import { canGoBack, canGoForward, closedTabCount, current, goBack, goForward, openChannel, openConversation, openInNewTab, recentPlaces, reopenClosedTab } from "../core/navigation";
import { quickSwitcherOpen, setQuickSwitcherOpen } from "../core/quickSwitcher";
import { relativeTime } from "../core/time";
import { appSettings, closeOverlays, narrow, showOverlay, workspacePage, type Overlay } from "../core/ui";
import { channelLabel, findChannel, workspaceApi, workspaces, type Channel } from "../core/workspaces";
import { decodeEmoji } from "../markdown/emoji";
import { listMessages, snippet, type ChatMessage } from "../plugins/builtin/chat/data";
import { Icon } from "../theme/icons";
import Avatar from "../ui/Avatar";
import Dialog from "../ui/Dialog";
import SearchBox from "../ui/SearchBox";
import { settingsSections } from "./Settings";
import { newBlankTab } from "./shortcuts";
import { workspaceSettingsSections } from "./WorkspaceSettings";
import "./QuickSwitcher.css";

interface Row {
  key: string;
  section: string;
  title: string;
  detail?: string;
  icon?: string;
  avatar?: JSX.Element;
  shortcut?: string;
  run: (newTab: boolean) => void;
}

const channelLimit = 8;
const messageLimit = 20;
const typingPauseMs = 180;

async function loadMessages(workspaceId: string): Promise<ChatMessage[]> {
  const api = workspaceApi(workspaceId).plugin("chat");
  const chats = workspaces.byId[workspaceId]?.channels.filter((c) => c.type === "chat") ?? [];
  const lists = await Promise.all(chats.map((c) => listMessages(api, c.id).catch(() => [])));
  return lists.flat().filter((m) => m.kind === "message" && !m.deleted);
}

function channelRow(workspaceId: string, channel: Channel, section: string): Row {
  const here = current()?.workspaceId === workspaceId;
  const workspace = workspaces.byId[workspaceId]?.info.name;
  return {
    key: `channel:${workspaceId}:${channel.id}`, section, title: channelLabel(workspaceId, channel), icon: channelType(channel.type).icon,
    detail: here ? channelType(channel.type).label : workspace,
    run: (newTab) => {
      closeOverlays();
      if (newTab) openInNewTab({ workspaceId, channelId: channel.id });
      else openChannel(workspaceId, channel.id);
    },
  };
}

export function SwitcherList(props: { onDone?: () => void; focusOnShow: boolean }) {
  const [query, setQuery] = createSignal("");
  const [settled, setSettled] = createSignal("");
  const [active, setActive] = createSignal(0);
  let list: HTMLDivElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const type = (text: string) => {
    setQuery(text);
    clearTimeout(timer);
    timer = setTimeout(() => setSettled(text), typingPauseMs);
  };

  const workspaceId = () => {
    const id = current()?.workspaceId;
    return id && workspaces.byId[id] ? id : "";
  };
  const parsed = createMemo(() => parseSearch(query()));
  const narrowed = () => parsed().authors.length + parsed().channels.length > 0;

  const [objects] = createResource(() => ({ id: workspaceId(), text: settled().trim() }), async ({ id, text }) =>
    id && text && !/\b(in|by):/.test(text) ? (await searchLinks(id, text, 12)).filter((hit) => hit.kind !== "channel") : []);
  // Every chat's messages are only read once the member searches for words.
  const [messages] = createResource(() => (settled().trim() && workspaceId()) || null, loadMessages);

  const recentRows = (): Row[] => recentPlaces().flatMap((place) => {
    const channel = place.channelId === null ? undefined : findChannel(place.workspaceId, place.channelId);
    return channel ? [channelRow(place.workspaceId, channel, "Recent")] : [];
  });
  const channelRows = (): Row[] => {
    const q = parsed();
    if (narrowed()) return [];
    const all = workspaces.order.flatMap((id) => (workspaces.byId[id]?.channels ?? []).map((c) => ({ id, c })));
    // The current workspace's come first.
    const ordered = [...all.filter((x) => x.id === workspaceId()), ...all.filter((x) => x.id !== workspaceId())];
    return ordered.filter(({ c }) => holdsWords(c.name, q.words)).slice(0, channelLimit).map(({ id, c }) => channelRow(id, c, "Channels"));
  };
  const objectRows = (): Row[] => (objects.latest ?? []).map((hit) => ({
    key: `object:${hit.url}`, section: "In channels", title: hit.title, detail: hit.where, icon: hit.icon,
    run: (newTab) => {
      closeOverlays();
      openLink(hit.url, newTab);
    },
  }));
  const messageRows = (): Row[] => {
    const id = workspaceId();
    const q = parsed();
    if (!id) return [];
    const people = memberListVisible(id);
    const authorIds = q.authors.map((a) => new Set(people.filter((m) => memberMatches(m, a)).map((m) => m.id)));
    const channelOf = (cid: number) => workspaces.byId[id]?.channels.find((c) => c.id === cid);
    const hits = (messages.latest ?? []).filter((m) => {
      const channel = channelOf(m.channelId);
      if (!channel) return false;
      if (!q.channels.every((c) => channel.name.toLowerCase().includes(c))) return false;
      if (!authorIds.every((ids) => ids.has(m.authorId))) return false;
      return holdsWords(`${decodeEmoji(m.body)} ${m.attachments.map((a) => a.name).join(" ")}`, q.words);
    });
    return hits.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, messageLimit).map((m) => {
      const channel = channelOf(m.channelId);
      const author = member(id, m.authorId);
      return {
        key: `message:${m.id}`, section: "Messages", title: snippet(m.body, 120),
        detail: `${author.displayName} in ${channel ? channelLabel(id, channel) : "a channel"}, ${relativeTime(m.createdAt)}`,
        avatar: <Avatar user={author} size={24} />,
        run: (newTab) => {
          closeOverlays();
          const target = { kind: "message", id: m.id };
          if (newTab) openInNewTab({ workspaceId: id, channelId: m.channelId, target });
          else openChannel(id, m.channelId, target);
        },
      };
    });
  };
  const commandRows = (): Row[] => {
    const id = workspaceId();
    const command = (title: string, icon: string, run: () => void, shortcut?: string): Row => ({
      key: `command:${title}`, section: "Commands", title, icon, shortcut, run,
    });
    const all = [
      command("New tab", "tab-new", newBlankTab, "Ctrl+T"),
      ...(closedTabCount() ? [command("Reopen closed tab", "history", reopenClosedTab, "Ctrl+Shift+T")] : []),
      ...(canGoBack() ? [command("Go back", "back", goBack, "Alt+Left")] : []),
      ...(canGoForward() ? [command("Go forward", "forward", goForward, "Alt+Right")] : []),
      command("Private messages", "messages", () => openConversation()),
      command("Settings", "settings", () => showOverlay(appSettings())),
      ...(id ? [
        command("Workspace settings", "admin", () => showOverlay(workspacePage(id))),
        command("Your profile in this workspace", "profile", () => showOverlay(workspacePage(id, "profile"))),
      ] : []),
    ];
    return narrowed() ? [] : all.filter((c) => holdsWords(c.title, parsed().words));
  };
  // Every settings section, found by its name or what is on it. Only while searching: they would fill the list.
  const settingsRows = (): Row[] => {
    if (narrowed()) return [];
    const id = workspaceId();
    const row = (group: string, icon: string, section: { id: string; label: string; keywords: string }, overlay: () => Overlay): Row[] =>
      holdsWords(`${group} settings ${section.label} ${section.keywords}`, parsed().words)
        ? [{ key: `settings:${group}:${section.id}`, section: "Settings", title: section.label, detail: `${group} settings`, icon, run: () => showOverlay(overlay()) }]
        : [];
    return [
      ...settingsSections.flatMap((s) => row("App", "settings", s, () => appSettings(s.id))),
      ...(id ? workspaceSettingsSections.filter((s) => s.id !== "profile").flatMap((s) => row("Workspace", "admin", s, () => workspacePage(id, s.id))) : []),
    ];
  };

  const rows = createMemo<Row[]>(() => {
    if (isEmptySearch(parsed())) return [...recentRows(), ...commandRows()];
    return [...channelRows(), ...commandRows(), ...settingsRows(), ...objectRows(), ...messageRows()];
  });
  createEffect(on(query, () => setActive(0)));
  createEffect(on(active, (index) => list?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: "nearest" }), { defer: true }));

  const choose = (row: Row, newTab: boolean) => {
    row.run(newTab);
    props.onDone?.();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const count = rows().length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (count) setActive((active() + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows()[active()];
      if (row) choose(row, e.ctrlKey || e.metaKey);
    }
  };
  const searching = () => settled() !== query() || objects.loading || messages.loading;

  return (
    <div class="quick-switcher-list" role="presentation" onKeyDown={onKeyDown}>
      <SearchBox workspaceId={workspaceId()} value={query()} onInput={type} operators={workspaceId() ? ["in", "by"] : []} focusOnShow={props.focusOnShow}
        placeholder="Go to a channel, or search everything..." label="Search everything">
        <Icon name="search" />
      </SearchBox>
      <div ref={list} class="quick-switcher-rows mw-scroll-fade" role="listbox" aria-label="Results">
        <For each={rows()}>
          {(row, i) => (
            <>
              <Show when={rows()[i() - 1]?.section !== row.section}><h3 class="quick-switcher-section">{row.section}</h3></Show>
              <button class="quick-switcher-row" classList={{ active: active() === i() }} role="option" aria-selected={active() === i()} data-row={i()}
                onMouseMove={() => setActive(i())} onClick={(e) => choose(row, e.ctrlKey || e.metaKey)}>
                <Show when={row.avatar} fallback={<Icon name={row.icon ?? "channel-chat"} />}>{row.avatar}</Show>
                <span class="quick-switcher-title">{row.title}</span>
                <Show when={row.detail}><span class="quick-switcher-detail muted">{row.detail}</span></Show>
                <Show when={row.shortcut}><kbd class="muted">{row.shortcut}</kbd></Show>
              </button>
            </>
          )}
        </For>
        <Show when={rows().length === 0}>
          <p class="view-note">{searching() ? "Searching..." : "Nothing found."}</p>
        </Show>
      </div>
      <p class="quick-switcher-hint muted hint">Enter opens, Ctrl+Enter in a new tab. Narrow messages with in:channel and by:member.</p>
    </div>
  );
}

export default function QuickSwitcher() {
  const close = () => setQuickSwitcherOpen(false);
  return (
    <Dialog open={quickSwitcherOpen()} title="Go to" onClose={close} class="quick-switcher">
      <Show when={quickSwitcherOpen()}><SwitcherList onDone={close} focusOnShow={!narrow()} /></Show>
    </Dialog>
  );
}

