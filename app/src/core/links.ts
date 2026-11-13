// makework:// links to channels and to objects inside them (messages, tasks, files, ...), so anything can be
// linked anywhere: makework://<server>/<channel>[/<kind>/<id>]. Plugins name and find the objects (LinkProvider).
// Copied links are web links (https://app.makework.dev/open/...) so other apps make them clickable; opened in a
// browser they offer the desktop app or the web app (shell/OpenLinkPrompt). Inside MakeWork both forms are the same link.
import { copyText } from "./clipboard";
import { createRoot, createSignal, type Accessor } from "solid-js";
import { channelType } from "./channelTypes";
import { account } from "./account";
import { assignableMembers, member, memberList, myId } from "./members";
import { openChannel, openInNewTab } from "./navigation";
import { findCategory, findChannel, workspaceApi, workspaces, type Channel } from "./workspaces";
import { exportProviderFor, linkProviderFor } from "../plugins/registry";
import type { LinkContext, LinkInfo, LinkResult, LinkTarget } from "../plugins/types";
import type { MenuEntry } from "../ui/contextMenu";

export interface LinkRef {
  workspaceId: string;
  channelId: number;
  target?: LinkTarget;
}

const scheme = "makework://";
export const webLinkBase = "https://app.makework.dev/open/";
export const isLink = (url: string) => url.startsWith(scheme) || url.startsWith(webLinkBase);

// The makework:// form of a link in either form.
export function appLink(url: string): string {
  if (!url.startsWith(webLinkBase)) return url;
  const rest = url.slice(webLinkBase.length);
  const end = rest.search(/[?#]/);
  return scheme + (end < 0 ? rest : rest.slice(0, end));
}

// The form to share outside MakeWork.
export function webLink(url: string): string {
  return url.startsWith(scheme) ? webLinkBase + url.slice(scheme.length) : url;
}

export function linkUrl(ref: LinkRef): string {
  const base = `${scheme}${encodeURIComponent(ref.workspaceId)}/${ref.channelId}`;
  return ref.target ? `${base}/${encodeURIComponent(ref.target.kind)}/${encodeURIComponent(ref.target.id)}` : base;
}

export function parseLink(url: string): LinkRef | null {
  const match = /^makework:\/\/([^/\s]+)\/(\d+)(?:\/([a-z][a-z0-9-]*)\/([^/\s]+))?\/?$/.exec(appLink(url.trim()));
  if (!match) return null;
  const [, server, channel, kind, id] = match;
  try {
    const targetId = id && decodeURIComponent(id);
    if (kind && targetId && !/^\d+$/.test(targetId) && kind !== "export") return null;
    return {
      workspaceId: decodeURIComponent(server),
      channelId: Number(channel),
      ...(kind && targetId && { target: { kind, id: /^\d+$/.test(targetId) ? Number(targetId) : targetId } }),
    };
  } catch {
    return null;
  }
}

export function openLink(url: string, newTab = false): boolean {
  const ref = parseLink(url);
  if (!ref || !workspaces.byId[ref.workspaceId]) return false;
  if (newTab) openInNewTab({ workspaceId: ref.workspaceId, channelId: ref.channelId, target: ref.target });
  else openChannel(ref.workspaceId, ref.channelId, ref.target);
  return true;
}

export function copyLink(url: string): void {
  void copyText(webLink(url), "Link copied");
}

// Right-click menu entries for a link: makework links open here, others in the browser.
export function linkMenu(url: string, extra: MenuEntry[] = []): MenuEntry[] {
  if (!isLink(url)) return [
    { label: "Open link", icon: "link", action: () => void window.open(url, "_blank", "noopener,noreferrer") },
    { label: "Copy link", icon: "copy", action: () => copyLink(url) },
    ...extra,
  ];
  return [
    { label: "Open", icon: "forward", action: () => void openLink(url) },
    { label: "Open in new tab", icon: "tab-new", action: () => void openLink(url, true) },
    { label: "Copy link", icon: "copy", action: () => copyLink(url) },
    ...extra,
  ];
}

export function linkContext(workspaceId: string, channel: Channel): LinkContext {
  const workspace = { id: workspaceId, name: workspaces.byId[workspaceId]?.info.name ?? workspaceId };
  return {
    workspace,
    get server() { return workspace; },
    channel: { id: channel.id, name: channel.name, type: channel.type, category: findCategory(workspaceId, channel.categoryId)?.name ?? "" },
    user: { username: account()?.username ?? "", displayName: account()?.displayName ?? "" },
    users: { me: () => myId(workspaceId), get: (id) => member(workspaceId, id), list: () => memberList(workspaceId), assignable: () => assignableMembers(workspaceId) },
    api: workspaceApi(workspaceId).plugin(channel.type),
  };
}

export interface ResolvedLink extends LinkInfo {
  icon: string;
  where: string;      // "Server / category / channel"
  missing?: boolean;  // the object or channel is gone, or the workspace isn't connected
}

// Titles are looked up once per link and again when the channel type's plugin reports a change.
const cache = new Map<string, Accessor<ResolvedLink | undefined>>();
const refreshers = new Map<string, Set<() => void>>();
const watched = new Set<string>();

export function resolveLink(url: string): Accessor<ResolvedLink | undefined> {
  const cached = cache.get(url);
  if (cached) return cached;
  return createRoot(() => {
    const [value, setValue] = createSignal<ResolvedLink | undefined>();
    const load = () => void resolve(url).then(setValue, () => setValue(undefined));
    cache.set(url, value);
    const ref = parseLink(url);
    const channel = ref && findChannel(ref.workspaceId, ref.channelId);
    if (ref && channel) {
      const key = `${ref.workspaceId}:${channel.type}`;
      if (!refreshers.has(key)) refreshers.set(key, new Set());
      refreshers.get(key)!.add(load);
      if (!watched.has(key)) {
        watched.add(key);
        workspaceApi(ref.workspaceId).plugin(channel.type).onEvent(() => refreshers.get(key)?.forEach((f) => f()));
      }
    }
    load();
    return value;
  });
}

async function resolve(url: string): Promise<ResolvedLink> {
  const ref = parseLink(url);
  const server = ref && workspaces.byId[ref.workspaceId];
  const channel = ref && findChannel(ref.workspaceId, ref.channelId);
  if (!ref || !server || !channel) return { title: "Unknown link", icon: "channel-other", where: url, missing: true };
  const type = channelType(channel.type);
  const where = `${server.info.name} / ${findCategory(ref.workspaceId, channel.categoryId)?.name ?? ""} / ${channel.name}`;
  if (!ref.target) return { title: channel.name, icon: type.icon, where };
  if (ref.target.kind === "export") {
    const item = await exportProviderFor(channel.type)?.list(linkContext(ref.workspaceId, channel))
      .then((items) => items.find((entry) => String(entry.id) === String(ref.target!.id)))
      .catch(() => null);
    return item
      ? { title: item.name, icon: "image", where }
      : { title: `${ref.target.kind} ${ref.target.id}`, icon: type.icon, where, missing: true };
  }
  const info = await linkProviderFor(channel.type)?.resolve?.(ref.target, linkContext(ref.workspaceId, channel)).catch(() => null);
  if (!info) return { title: `${ref.target.kind} ${ref.target.id}`, icon: type.icon, where, missing: true };
  return { ...info, icon: info.icon ?? type.icon, where };
}

export interface SearchHit extends LinkResult {
  url: string;
  icon: string;
  where: string;
}

// Channels and objects on a workspace whose names match, for the link picker. "tasks/fix" searches the
// channels matching "tasks" for objects matching "fix".
export async function searchLinks(workspaceId: string, query: string, limit = 12): Promise<SearchHit[]> {
  const server = workspaces.byId[workspaceId];
  if (!server) return [];
  const q = query.trim().toLowerCase();
  const where = (c: Channel) => `${findCategory(workspaceId, c.categoryId)?.name ?? ""}/${c.name}`;
  const channels: SearchHit[] = server.channels
    .filter((c) => !q || where(c).toLowerCase().includes(q))
    .map((c) => ({
      kind: "channel", id: c.id, title: c.name, detail: channelType(c.type).label, icon: channelType(c.type).icon,
      where: where(c), url: linkUrl({ workspaceId, channelId: c.id }),
    }));
  if (!q) return channels.slice(0, limit);
  const slash = q.lastIndexOf("/");
  const scope = slash < 0 ? "" : q.slice(0, slash);
  const term = slash < 0 ? q : q.slice(slash + 1);
  const scoped = server.channels.filter((c) => !scope || where(c).toLowerCase().includes(scope));
  const objects = await Promise.all(scoped.map(async (c) => {
    const provider = linkProviderFor(c.type);
    const context = linkContext(workspaceId, c);
    const links = provider?.search
      ? await provider.search(term, context).catch(() => [])
      : [];
    const exports = await exportProviderFor(c.type)?.list(context).catch(() => []) ?? [];
    const found: LinkResult[] = [
      ...links,
      ...exports.filter((item) => item.name.toLowerCase().includes(term)).map((item) => ({
        kind: "export", id: item.id, title: item.name, detail: "export",
      })),
    ];
    return found.map((r) => ({
        ...r, icon: r.icon ?? channelType(c.type).icon, where: where(c),
        url: linkUrl({ workspaceId, channelId: c.id, target: { kind: r.kind, id: r.id } }),
      }));
  }));
  // Channels whose names match must not push every object out of the list.
  const found = objects.flat();
  const keep = Math.max(limit - found.length, Math.min(channels.length, 4));
  return [...channels.slice(0, keep), ...found].slice(0, limit);
}
