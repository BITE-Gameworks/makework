// The contract between the app and client plugins. Documented for authors in docs/plugins.md.
import type { JSX } from "solid-js";
import type { PluginClient } from "../api/client";
import type { JsonRow } from "../system/data";
import type { SoundName, ThemeFile } from "../theme/schema";

export interface ChannelTypeInfo {
  id: string;      // the workspace plugin behind the channel, e.g. "chat"
  label: string;
  // One line on what it is for, in the new channel dialog.
  description?: string;
  icon: string;    // an icon name (see theme/icons.tsx) or a data:image/svg+xml URL
  // The shape shown while its view loads: messages, board, grid, canvas, collage, list, document, pages, voice
  // (else generic).
  loader?: string;
  // false: the view mounts fresh each visit. A number: seconds a hidden kept view is kept after it was last
  // shown, so coming back shows it as it was in the meantime. Omitted: kept until the window's bound lets it go.
  keepAlive?: number | false;
  // false: the view only works in the main window, so its tabs can't be popped out (voice: calls and their media
  // stay in the main window). Omitted: the view can have its own window.
  ownWindow?: boolean;
}

export interface ViewerInfo {
  id: string;
  label: string;
  mimeTypes?: string[];
  extensions?: string[];   // without the dot, e.g. "md"
}

// The set of values a plugin's declared tables can hold (the reason they sync without running the plugin's code
// during replay). "user" is the id of one of the workspace's members.
export type DeclaredType = "text" | "integer" | "real" | "bool" | "json" | "user";

export interface DeclaredTable {
  // Column names with their types; a column of a child table holding rows of `channel` may declare any of these.
  columns: Record<string, DeclaredType>;
  // Rows belong to a channel (they have a channel_id column); without it the table is channel-wide and only the
  // declared plugin itself can change it.
  channel?: boolean;
  // The column naming who added each row: checked on insert, and the only column an update may change on someone
  // else's row (besides the table's own rules).
  authored?: string;
  // Rows are their author's, or anyone's with manage_messages.
  owned?: boolean;
}

export interface PluginDataManifest {
  // The channel type this plugin backs, when it isn't its first contributed channel type.
  type?: string;
  // Table name -> how its rows sync. Names start with the plugin's data name (its type, or its id with '.' and
  // '-' mapped to '_', e.g. pingpong_games for id "pingpong" or "example.pingpong").
  tables: Record<string, DeclaredTable>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  // An SVG path in the .mwp package (for example "icon.svg"), drawn in the theme's text color. Built-in plugins
  // give an icon name instead.
  icon?: string;
  // The app version this plugin needs (the install is refused when the app is older).
  minApp?: string;
  // Declared tables the workspace plugin keeps (see docs/plugins.md); without them the plugin can't store anything.
  data?: PluginDataManifest;
  contributes?: {
    channelTypes?: ChannelTypeInfo[];
    viewers?: ViewerInfo[];
    themes?: ThemeFile[];
    iconSets?: Record<string, Record<string, string>>;
  };
}

export interface UserInfo {
  id: number;
  username: string;
  displayName: string;
  color: string;
  // "gen:<seed>" or a data:image URL; see ui/Avatar.
  avatar: string;
  bot?: boolean;
  botType?: string;
}

export interface ChannelContext {
  workspace: { id: string; name: string };
  /** @deprecated Use workspace. */
  readonly server: { id: string; name: string };
  channel: { id: number; name: string; type: string; category: string };
  user: { username: string; displayName: string };
  // Profiles on this workspace; me() is the signed-in user's id there.
  users: {
    me(): number | null;
    get(id: number): UserInfo;
    list(): UserInfo[];
    // Who work can be assigned to: people, and bots set to be assignable in Workspace settings > Bots.
    assignable(): UserInfo[];
  };
  // Pinned to the channel's plugin on its workspace.
  api: PluginClient;
  // Opens the side panel; a `key` (unique within this channel) names it for isSidePanelOpen. Panels a channel opened
  // close when the user leaves it.
  openSidePanel(title: string, mount: Mount, key?: string): void;
  // For buttons that open a panel: opens it, or closes it when that panel is already open.
  toggleSidePanel(key: string, title: string, mount: Mount): void;
  // Whether the panel named `key` is the one open; reactive.
  isSidePanelOpen(key: string): boolean;
  closeSidePanel(): void;
  // Opens a file in the best installed viewer, full window.
  openFile(file: FileContext): void;
  // The object a link pointed at when it opened this channel (a new object each time a link is followed).
  target(): LinkTarget | null;
  // A makework:// link to this channel, or to an object in it.
  linkTo(target?: LinkTarget): string;
  // Follows a makework:// link: opens its channel and points the view at the object.
  openLink(url: string): void;
  // A right-click menu at the pointer.
  openContextMenu(event: MouseEvent, entries: MenuEntry[]): void;
  // A file in the plugin's package ("assets/logo.svg", "icon.svg") as a data URL, or null when the device
  // doesn't have the package or the file.
  asset(path: string): Promise<string | null>;
  // The app's right-click menu for a member (profile, copy name, ...).
  openUserMenu(event: MouseEvent, userId: number): void;
  // One of the theme's sounds, for example "task-done", "upload-done" or "error".
  playSound(name: SoundName): void;
  // Undo/redo for this channel: push what the user did, with how to undo and redo it.
  history: History;
  // Whether the view is shown; reactive. False while the view of a channel type with `keepAlive` stays open,
  // hidden, after the user left it (presence and cursor are held back meanwhile).
  active(): boolean;
  // Live, unsaved state shared with the other members who have this channel open (selections, what they have
  // open). set() sends yours (a JSON object, null to clear; rate-limited); others() is reactive. The key `cursor`
  // is reserved for `cursors`.
  presence: {
    set(state: { [key: string]: PresenceState } | null): void;
    others(): { userId: number; state: PresenceState }[];
  };
  // Virtual cursors: every member's pointer, in the view's own coordinates (board or page units), shown in
  // their color with their name.
  hosting?(url: string, size?: number | null): import("../p2p/nodes").ContentHosting | null;
  cursors: {
    // Yours; null when the pointer left the view. Call it on every pointer move (rate-limited).
    move(at: CursorPoint | null): void;
    // Others' pointers; reactive.
    others(): ({ userId: number } & CursorPoint)[];
    // Draws the others' cursors into `element` (which should cover the view, position: relative or absolute).
    // `toScreen` maps view coordinates to px from the element's top left; call redraw() after the view pans or
    // zooms. Solid views can use ui/RemoteCursors instead.
    draw(element: HTMLElement, toScreen: (at: CursorPoint) => CursorPoint): { redraw(): void; remove(): void };
  };
  // Media for the other members who have this channel open (a shared page's video): one stream at a time, null
  // stops it. others() is reactive.
  streams: {
    share(stream: MediaStream | null): void;
    others(): { userId: number; stream: MediaStream }[];
  };
  // Short messages to the other members who have this channel open, sent at once and never stored (a click in a
  // shared browser). Each member's messages arrive in order. listen() returns a function that stops listening.
  events: {
    // `to` sends to that member alone.
    send(message: PresenceState, to?: number): void;
    listen(handler: (userId: number, message: PresenceState) => void): () => void;
  };
  // Whether the signed-in user has a workspace permission ("send_messages", "edit_content", "manage_messages", ...);
  // reactive. Changes without it are refused by the workspace, so views hide or disable those controls.
  can(permission: string): boolean;
  // The plugin's own settings (ClientPlugin.settings) on this device, reactive; the declared default when unset.
  setting(key: string): unknown;
  secret(key: string): Promise<string | null>;
}

export type { History, HistoryEntry } from "../core/history";
export type { CursorPoint, PresenceState } from "../core/presence";
import type { CursorPoint, PresenceState } from "../core/presence";
import type { History } from "../core/history";

export type { MenuEntry, MenuItem } from "../ui/contextMenu";
export type { SoundName } from "../theme/schema";
import type { MenuEntry } from "../ui/contextMenu";

// An object inside a channel that links can point at, e.g. { kind: "task", id: 7 }.
export interface LinkTarget {
  kind: string;
  id: number | string;
}

export interface LinkInfo {
  title: string;
  icon?: string;     // icon name, defaults to the channel type's icon
  detail?: string;   // a short second line in search results
}

export interface LinkResult extends LinkTarget, LinkInfo {}

// What a link provider gets: the channel the object lives in.
export type LinkContext = Pick<ChannelContext, "workspace" | "server" | "channel" | "user" | "users" | "api">;

// Lets links point at objects in a channel type's channels: names them and finds them for the link picker.
export interface LinkProvider {
  resolve?(target: LinkTarget, context: LinkContext): Promise<LinkInfo | null>;
  search?(query: string, context: LinkContext): Promise<LinkResult[]>;
}

export interface ExportInfo {
  id: number | string;
  name: string;
  kinds: ("image" | "svg" | "table" | "text")[];
}

export interface ExportProvider {
  list(context: LinkContext): Promise<ExportInfo[]>;
  render(
    id: number | string,
    kind: ExportInfo["kinds"][number],
    context: LinkContext,
    element: HTMLElement,
  ): void | (() => void) | Promise<void | (() => void)>;
  file?(id: number | string, format: string, context: LinkContext): Promise<{ name: string; blob: Blob }>;
}

// Renders into the element; the returned function is called on unmount.
export type Mount = (element: HTMLElement) => void | (() => void);
export type ChannelView = (element: HTMLElement, context: ChannelContext) => void | (() => void);

export interface FileContext {
  name: string;
  mimeType: string;
  size: number;
  // The content; fetched once, on first call.
  read(): Promise<Blob>;
  // Set when the file can be edited in place; the viewer then offers an Edit button.
  edit?(): void;
  // More buttons in the viewer's header (Start a watch party).
  actions?: { label: string; icon: string; run: () => void }[];
}
export type FileViewer = (element: HTMLElement, file: FileContext) => void | (() => void);

// A channel in the workspace's readable folder on disk (desktop): content files by hash and generated text files, by
// path inside the channel's folder.
export type DiskEntry = { path: string[]; hash: string } | { path: string[]; text: string };

export interface DiskContext {
  channel: { id: number; name: string };
  // The channel's rows of a table (its channel_id), or for a child table without one, the rows whose `by.column`
  // is one of `by.ids` (attachments by message_id).
  rows(plugin: string, table: string, by?: { column: string; ids: Iterable<number> }): JsonRow[];
  // The content hash of an mwc: ref when this device keeps it, else null.
  kept(url: unknown): string | null;
  // The file extension kept content's first bytes show (".png"), for content stored without a type; "" until known.
  fileExtension(hash: string): string;
  // A file name no other entry in that folder has (ignoring case), the same for the same key on every call. Key it
  // by what the file is (a row id, a hash), so text that refers to it can ask again.
  name(folder: string[], key: string, wanted: string): string;
  exportFile?(url: string, format: string): Promise<{ name: string; blob: Blob } | null>;
}

// A file in the channel's folder that someone changed on disk (path inside the folder). "moved": a file the app
// wrote, found at another path with the same content (`from`). `base` is what the app last wrote at the path (a
// content hash, or "text:" and the text's SHA-256); `hash` (and `text` for small .md/.json/.svg/.txt files), size
// and time are the file now.
export interface DiskChange {
  kind: "added" | "changed" | "removed" | "moved";
  path: string[];
  from?: string[];
  base?: string;
  hash?: string;
  text?: string;
  size?: number;
  mtimeMs?: number;
}

export interface DiskApplyContext extends DiskContext {
  api(plugin: string): PluginClient;
  // After the change is in the data: the file on disk is what the app wrote there (content is found there from now
  // on). `moveTo` (a path in the channel folder) moves it first, e.g. to "name (conflict).ext". False when the file
  // changed again meanwhile. `text`: the layout writes this file as text (else it is content, found by hash).
  adopt(change: DiskChange, moveTo?: string[], text?: boolean): Promise<boolean>;
  // Size and preview of an image that is on this computer.
  imageInfo(hash: string, mime: string): Promise<{ thumb: string | null; width: number | null; height: number | null }>;
  // A change that couldn't be made, shown to the user.
  problem(change: DiskChange, message: string): void;
}

// Deleting in the data what was deleted on disk; `what` names it for the question ("3 files").
export interface DiskRemoval {
  what: string;
  remove(): Promise<void>;
}

export interface DiskLayout {
  entries(context: DiskContext): DiskEntry[] | Promise<DiskEntry[]>;
  // Added, changed and moved files made into changes of the data. The context's names are those of a fresh
  // `entries` call, so paths map back to rows the same way.
  apply?(changes: DiskChange[], context: DiskApplyContext): Promise<void>;
  // What to delete for files removed on disk, or null to write them again.
  removal?(changes: DiskChange[], context: DiskApplyContext): DiskRemoval | null | Promise<DiskRemoval | null>;
}

// What an agent can do in a channel of some type: a typed function the model picks. The plugin that owns the channel type
// contributes these (`ClientPlugin.agentSkills`), so a new plugin works with agents without agents knowing it.
export interface SkillEnv {
  server: import("../core/llm").LlmServer;
  imageSide: number;
  channelId?: number;
  threadId?: number | null;
  // The job the skill runs for: a long skill stops when it is stopped. (A bot can run several jobs at once.)
  signal?: AbortSignal;
}
// A picture in a result goes to the model as an image (data URL) next to the text.
// `embeds` are markdown embeds (like ![name](makework://...)) added to the end of the final answer as they are, so the
// reader sees the picture without the model having to copy a link.
export type SkillResult = string | { text: string; images?: string[]; embeds?: string[] };

export interface AgentSkill {
  name: string;
  description: string;
  // Property name -> JSON schema type, all required.
  args: Record<string, "string" | "number">;
  // Bot permissions it needs, for example "read:docs" and "write:docs".
  permissions: string[];
  // The channel type this skill works in; it is only offered when the workspace has one.
  channelType?: string;
  run(context: BotContext, args: Record<string, string | number>, env: SkillEnv): Promise<SkillResult>;
}

export interface AgentItem {
  channelId: number;
  id: number;
  // A name or title (searched with more weight); for chat the author.
  label: string;
  // Body text, if the item has one.
  text?: string;
}

// How agents look at what a channel type holds: search, the workspace overview and the index cards are all made from
// this, so none of them knows any plugin's tables.
export interface AgentIndexer {
  permissions: string[];
  // What the channel holds, for the overview ("files and folders", "pages", "tasks").
  noun: string;
  // The items of these channels (read once for all of them: never one read per channel).
  items(context: BotContext, channels: { id: number; name: string }[]): Promise<AgentItem[]>;
  // The overview line when the first few labels are not the interesting part (chat: the latest message).
  overview?(items: AgentItem[], context: BotContext): string;
  // Every item is an index card of its own, of this kind (docs pages), instead of one card per channel.
  cards?: { kind: string };
  // Channels with fewer items are left out of the index.
  minItems?: number;
  // The text an index card of a channel is written from; by default the sorted labels, 300 at most.
  cardText?(items: AgentItem[], context: BotContext): string;
}

export interface ClientPlugin {
  manifest: PluginManifest;
  channelViews?: Record<string, ChannelView>;   // by channel type id
  viewers?: Record<string, FileViewer>;         // by viewer id
  links?: Record<string, LinkProvider>;         // by channel type id
  exports?: Record<string, ExportProvider>;     // by channel type id
  disk?: Record<string, DiskLayout>;            // by channel type id
  bots?: Record<string, BotType>;
  agentSkills?: Record<string, AgentSkill[]>;   // by channel type id
  agentIndex?: Record<string, AgentIndexer>;    // by channel type id
  // Shown under the plugin in Settings > Plugins and kept on this device; views read them with context.setting.
  settings?: PluginSetting[];
  // What the plugin has set for a whole workspace, drawn in Workspace settings > Plugins and synced by the plugin itself.
  workspaceSettings?: (props: { workspaceId: string }) => JSX.Element;
  // A short line after a category's name in the channel bar.
  categoryNote?: (name: string) => string | undefined;
}

// One setting a plugin offers. `when` shows it only while it applies (reads the other values); `desktop` only in
// the desktop app. A "secret" is kept in the system keychain on desktop and read with context.secret.
export type PluginSetting = {
  key: string;
  label: string;
  hint?: string;
  desktop?: boolean;
  when?: (value: (key: string) => unknown) => boolean;
} & (
  | { type: "heading" }
  | { type: "text"; default?: string; placeholder?: string }
  | { type: "secret"; placeholder?: string }
  | { type: "toggle"; default?: boolean }
  | { type: "number"; default?: number; min?: number; max?: number }
  | { type: "select"; default?: string; options: { value: string; label: string }[] }
  // A text field with suggestions asked for when it shows, again when one of `dependsOn` changes (a workspace's models).
  | { type: "suggest"; default?: string; placeholder?: string; dependsOn?: string[];
      suggest: (value: (key: string) => unknown, secret: (key: string) => Promise<string | null>) => Promise<string[]> }
  // Something of the plugin's own drawn in place (a list of downloads with their sizes); `label` names it.
  | { type: "custom"; render: () => JSX.Element }
);

// What a bot may ask for. Approved by an admin when the bot is added; the bot gets nothing else.
//   read:<plugin>  read that plugin's tables and watch its changes (tasks, git, files, members, channels)
//   write:<plugin> change that plugin's tables as the bot (checked by the bot's own roles, shown as the bot's work)
//   spawn          create helper bots of its own (they get at most the permissions it has)
//   memory         keep its own data (shown, with a clear button, in the Bots tab)
//   presence       see who is online
//   web            search the web and read public pages (desktop app only)
//   voice          join a voice channel as a member of the call and send sound and picture there
// Reading and writing chat in the channels it can see, and sending messages, need no permission.
export type BotPermission = `read:${string}` | `write:${string}` | "memory" | "presence" | "spawn" | "web" | "voice";

export interface BotAttachment { name: string; mime: string; url: string; thumb: string | null }
export interface BotMessage { id: number; channelId: number; threadId: number | null; authorId: number; body: string; createdAt: string; attachments?: BotAttachment[] }

export interface BotCommandCall {
  readonly message: BotMessage;
  readonly args: string;
  readonly words: string[];
  // Members named with @ in the arguments.
  readonly mentioned: number[];
}

export interface BotCommand {
  usage: string;
  help: string;
  // A reply is sent in the message's thread (or channel); null or "" sends none.
  run(context: BotContext, call: BotCommandCall): string | { text: string; buttons?: { label: string; command: string }[] } | null | Promise<string | { text: string; buttons?: { label: string; command: string }[] } | null>;
}

export interface BotMemory {
  get(key: string): string | null;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): string[];
}

// One entry of the workspace index: what a channel, page or note is about, for finding it without reading everything.
export interface LibraryEntry {
  channelId: number | null;
  kind: string;
  ref: string;
  title: string;
  summary: string;
  tags: string[];
  sourceHash: string;
}

// The workspace index (needs memory). Only entries of channels the bot sees are listed.
export interface BotLibrary {
  entries(): Promise<LibraryEntry[]>;
  save(entry: LibraryEntry): Promise<void>;
  remove(ref: string): Promise<void>;
}

// A bot in a call (needs voice). The call shows the bot as a member; its host's device sends what the bot gives.
export interface BotCall {
  // The voice channel a member is in now, or null.
  channelOf(userId: number): number | null;
  // The voice channel the bot is in, or null.
  current(): number | null;
  // Joins a voice channel, or moves to another one, sending these streams: `mic` as the bot's voice, `screen` as a
  // share named `label`. Called again in the same channel, it replaces the streams. Throws when the bot's host is in
  // a call of its own in another channel, or the channel is not a voice channel the bot may use.
  join(channelId: number, media: { mic?: MediaStream | null; screen?: MediaStream | null; label?: string }): Promise<void>;
  leave(): void;
}

export interface BotContext {
  readonly workspaceId: string;
  readonly bot: { id: number; type: string; nickname: string; config: Record<string, unknown> };
  readonly api: PluginClient;
  readonly userId: number;
  readonly channel: (id: number) => Promise<{ id: number; name: string; type: string } | null>;
  readonly channels: () => Promise<{ id: number; name: string; type: string; category?: string }[]>;
  readonly messages: (channelId: number) => Promise<{ id: number; author_id: number; body: string; thread_id: number | null; created_at: string; action?: boolean }[]>;
  // Channel ids the bot works in: the configured ones, or every channel when none are set.
  readonly inChannel: (channelId: number) => boolean;
  readonly send: (channelId: number, text: string, options?: { threadId?: number | null; buttons?: { label: string; command: string }[] }) => Promise<void>;
  // Posts as the bot itself (its own signed change) and returns the message id; `edit` changes such a message.
  // `action` makes it a small italic note about what the bot is doing; `steps` are the operations it performed (shown folded under the text); buttons with `input` open a text box.
  readonly post: (channelId: number, text: string, options?: { threadId?: number | null; action?: boolean; steps?: string[]; buttons?: { label: string; command: string; input?: boolean }[] }) => Promise<number>;
  // `buttons` replaces the buttons (an empty list removes them); left out keeps them.
  readonly edit: (messageId: number, text: string, buttons?: { label: string; command: string; input?: boolean }[]) => Promise<void>;
  // A client for one plugin whose changes are made as the bot. Needs write:<plugin>.
  readonly write: (plugin: string) => PluginClient;
  // The bot's pointer in a channel view (the view's own units), eased from where it was over `glideMs`; null removes it.
  readonly cursor: (channelId: number, at: { x: number; y: number } | null, glideMs?: number) => Promise<void>;
  // "... is working" under a chat channel's (or thread's) message box.
  // Undoes the changes the given bots made in a time window (newest first, one history entry each); changes that
  // someone edited since are left and counted as skipped.
  readonly undoWork: (botUserIds: number[], from: number, to: number) => Promise<{ undone: number; skipped: number }>;
  // Sets (or with null removes) a marker the bot shows in a channel view; other members and bots see it in `marks`.
  readonly mark: (channelId: number, key: string, value: string | number | null) => void;
  // Markers other members and bots (on other devices) show in a channel.
  readonly marks: (channelId: number) => { userId: number; key: string; value: unknown }[];
  // Removes all of the bot's cursors and markers.
  readonly leave: () => void;
  readonly typing: (channelId: number, threadId: number | null, on: boolean) => void;
  readonly log: (text: string) => Promise<void>;
  readonly openChannel: (channelId: number) => void;
  readonly openLink: (url: string) => boolean;
  // Needs read:<plugin>.
  readonly read: (plugin: string, table: string, where?: Record<string, string | number | boolean | null>) => Promise<Record<string, unknown>[]>;
  readonly onEvent: (plugin: string, handler: (event: { table: string; change: "insert" | "update" | "delete"; ids: number[] }) => void) => () => void;
  readonly member: (userId: number) => { id: number; displayName: string; username: string; bot: boolean };
  // Creates a bot of this workspace hosted by the same member; returns its user id. Needs spawn.
  readonly createBot: (type: string, nickname: string, config: Record<string, unknown>) => Promise<number>;
  // Renames one of the bots this bot created (name and member profile). Needs spawn.
  readonly renameBot: (botUserId: number, nickname: string) => Promise<void>;
  // Whether the admin gave the bot this permission.
  readonly granted: (permission: string) => boolean;
  // The secret a "credential" setting points to, when this device's account holds it (see core/credentials.ts).
  readonly secret: (setting: string) => Promise<string | null>;
  // Needs memory; throws without it.
  readonly memory: BotMemory;
  // Needs memory.
  readonly library: BotLibrary;
  // Needs presence.
  readonly online: () => number[];
  // Needs voice.
  readonly call: BotCall;
  // Whether a member holds a workspace permission (manage_messages ...), for commands that act on others.
  readonly can: (userId: number, permission: string) => boolean;
}

// How a bot type's robot faces look (ui/BotIcon): body colors, head shape and an optional eye color. Bots of one type
// are siblings; the seed (the bot's id) still varies ears, antenna, eyes and mouth.
export type BotPalette = "blue" | "white" | "green" | "yellow" | "purple" | "orange" | "steel";
export type BotFrame = "square" | "round";
export interface BotLook { palettes: BotPalette[]; frame: BotFrame; eyes?: string }

export interface BotType {
  label: string;
  // The faces of this type's bots, and how a bot of it is named when the admin gives no name.
  look?: BotLook;
  randomName?: (seed: number) => string;
  description?: string;
  // A long job in progress, and how to stop it: the bot's card then offers Stop.
  isBusy?: (botUserId: number) => boolean;
  stop?: (botUserId: number) => void;
  // How loud its voice and shared sound start for listeners in a call (1 is 100%), until they change it.
  defaultVolume?: number;
  // "channel" is one channel; "channels" lists channels, empty meaning any.
  // `suggest` offers values for a text field (a dropdown that also takes typing); `secret` hides what is typed.
  settings?: Record<string, {
    label: string; type: "text" | "number" | "bool" | "channel" | "channels" | "credential"; default?: string | number | boolean;
    // For channel settings: only channels of this type are offered ("voice").
    channelType?: string;
    placeholder?: string; secret?: boolean; suggest?: (config: Record<string, unknown>, secret: string | null, bots: PluginClient) => Promise<string[]>;
  }>;
  // Settings a new bot of this type starts with.
  defaultConfig?: () => Record<string, unknown>;
  permissions?: BotPermission[];
  // Typed after an @mention of the bot: "@bot /name args". A bare mention answers with these as buttons.
  commands?: Record<string, BotCommand>;
  // Free text after an @mention that is not a command. The reply is sent like a command's.
  mention?(context: BotContext, message: BotMessage, text: string): string | null | Promise<string | null>;
  start(context: BotContext): void | (() => void) | Promise<void | (() => void)>;
  fuzz?(context: BotContext): Promise<void>;
}
