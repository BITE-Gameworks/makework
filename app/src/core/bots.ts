// Runs the workspace's bots whose host is this account. Nothing about running is stored: the other devices of the
// same account agree over the mesh (core/botHosts.ts) and the first to start a bot keeps it. Logs stay on the
// device that runs the bot.
import { createStore } from "solid-js/store";
import type { ApiClient } from "../api/client";
import type { Permission, Row } from "../p2p/permissions";
import { botTypeFor, onBotContributionsChange } from "../plugins/registry";
import { workspaceLedger } from "./serverless";
import { applyWorkspaceUndo, planWorkspaceUndo } from "./workspaceHistoryActions";
import { credentialSecret, shareWithNewHolders } from "./credentials";
import { botHostLink, onBotHostLink } from "./botHosts";
import { encodeEmoji } from "../markdown/emoji";
import { openLink } from "./links";
import { openChannel } from "./navigation";
import { setBotRows, setBotsRunning } from "./botStatus";
import { commandArgs, grantedPermissions, parseBotCommand } from "./botCommands";
import { member, memberList } from "./members";
import { peerStatusOf, presenceOf, setBotPresence, type PresenceState } from "./presence";
import { standingOf } from "./roles";
import { canInChannel, canSeeChannel } from "./workspaces";
import { call as ownCall, voiceChannelOf } from "../voice/state";
import { mediaLink } from "../voice/media";
import type { BotCall, BotCommand, BotContext, BotLibrary, BotMemory } from "../plugins/types";
import { botConfig, botParent } from "./botConfig";

type Running = { since: number; key: string; stop?: () => void; stopped: boolean };
type Workspace = {
  api: ApiClient;
  me?: number;
  running: Map<number, Running>;
  busy: boolean;
  again: boolean;
  wait?: ReturnType<typeof setTimeout>;
  cleanups: (() => void)[];
};

const workspaces = new Map<string, Workspace>();
const [logs, setLogs] = createStore<Record<string, Record<number, string[]>>>({});

onBotContributionsChange(() => { for (const workspaceId of workspaces.keys()) schedule(workspaceId); });
onBotHostLink((workspaceId) => {
  const workspace = workspaces.get(workspaceId);
  const link = botHostLink(workspaceId);
  if (workspace && link) workspace.cleanups.push(link.onChange(() => schedule(workspaceId)));
  schedule(workspaceId);
});

// The last lines a bot running on this device logged.
export const botLog = (workspaceId: string, botId: number): string[] => logs[workspaceId]?.[botId] ?? [];

// Whether this device runs the bot now.
export const runsHere = (workspaceId: string, botId: number): boolean => !!workspaces.get(workspaceId)?.running.has(botId);

export function startBots(workspaceId: string, api: ApiClient): void {
  const known = workspaces.get(workspaceId);
  if (known?.api === api) return;
  if (known) stopBots(workspaceId);
  const workspace: Workspace = { api, running: new Map(), busy: false, again: false, cleanups: [] };
  workspaces.set(workspaceId, workspace);
  workspace.cleanups.push(api.plugin("bots").onEvent((event) => { if (event?.table === "bots_bots") schedule(workspaceId); }));
  const link = botHostLink(workspaceId);
  if (link) workspace.cleanups.push(link.onChange(() => schedule(workspaceId)));
  schedule(workspaceId);
}

export function stopBots(workspaceId: string): void {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) return;
  workspaces.delete(workspaceId);
  clearTimeout(workspace.wait);
  workspace.cleanups.forEach((cleanup) => cleanup());
  for (const entry of workspace.running.values()) halt(entry);
}

function log(workspaceId: string, botId: number, text: string) {
  const line = `${new Date().toLocaleTimeString()} ${text.trim().slice(0, 800)}`;
  setLogs(workspaceId, (old) => ({ ...old, [botId]: [...(old?.[botId] ?? []).slice(-199), line] }));
}

function halt(entry: Running) {
  entry.stopped = true;
  entry.stop?.();
}

function schedule(workspaceId: string) {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) return;
  if (workspace.busy) {
    workspace.again = true;
    return;
  }
  workspace.busy = true;
  void reconcile(workspaceId, workspace)
    .catch((e) => console.warn(`Bots of '${workspaceId}' not updated:`, e))
    .finally(() => {
      workspace.busy = false;
      if (workspace.again && workspaces.get(workspaceId) === workspace) {
        workspace.again = false;
        schedule(workspaceId);
      }
    });
}

// What a running bot restarts for when it changes. Being assignable only changes who task pickers list.
function runKey(row: Row): string {
  const { _assignable: _, ...config } = botConfig(row);
  return JSON.stringify([row.type, row.nickname, config]);
}

async function reconcile(workspaceId: string, workspace: Workspace) {
  const { api } = workspace;
  workspace.me ??= Number((await api.plugin("members").call<{ user_id: number }>("whoami")).user_id);
  const rows = await api.plugin("bots").read("bots_bots");
  if (workspaces.get(workspaceId) !== workspace) return;
  void shareWithNewHolders(workspaceId).catch((e) => console.warn("Credentials not shared:", e));
  const link = botHostLink(workspaceId);
  const claims = link?.claims() ?? new Map();
  const wanted = new Map<number, { row: Row; key: string }>();
  for (const row of rows)
    if (row.enabled === true && row.status === "enabled" && Number(row.host) === workspace.me)
      wanted.set(Number(row.id), { row, key: runKey(row) });

  for (const [id, entry] of workspace.running) {
    const want = wanted.get(id);
    // Two devices of this account started it at about the same time: the earlier start keeps it.
    const lost = !!link && (claims.get(id) ?? []).some((c: { device: string; since: number }) =>
      c.since < entry.since || (c.since === entry.since && c.device < link.device));
    if (want?.key === entry.key && !lost) continue;
    halt(entry);
    workspace.running.delete(id);
    log(workspaceId, id, lost ? "Stopped: another device of this account runs it." : "Stopped.");
  }

  const now = Date.now();
  for (const [id, { row, key }] of wanted) {
    if (workspace.running.has(id) || claims.get(id)?.length) continue;
    if (link && now < link.readyAt) {
      clearTimeout(workspace.wait);
      workspace.wait = setTimeout(() => schedule(workspaceId), link.readyAt - now);
      continue;
    }
    const contribution = botTypeFor(String(row.type));
    if (!contribution) {
      if (!botLog(workspaceId, id).at(-1)?.endsWith("is not installed on this device."))
        log(workspaceId, id, `The bot type '${String(row.type)}' is not installed on this device.`);
      continue;
    }
    const entry: Running = { since: now, key, stopped: false };
    workspace.running.set(id, entry);
    void run(workspaceId, workspace, id, row, entry, contribution.type);
  }
  setBotRows(workspaceId, rows, workspace.me ?? null);
  const userOf = new Map(rows.map((row) => [Number(row.id), Number(row.user_id)]));
  setBotsRunning(workspaceId, [...new Set([...workspace.running.keys(), ...claims.keys()])].flatMap((id) => userOf.get(id) ?? []));
  link?.announce(new Map([...workspace.running].map(([id, entry]) => [id, entry.since])));
}

// Messages older than this are history being caught up on, not requests to answer.
const freshMs = 60_000;
// Bot messages in a row after which bots stop answering each other.
const maxBotChain = 4;

async function run(workspaceId: string, workspace: Workspace, id: number, row: Row, entry: Running,
  type: NonNullable<ReturnType<typeof botTypeFor>>["type"]) {
  const { api } = workspace;
  const chat = api.plugin("chat");
  const config = botConfig(row);
  const live = () => !entry.stopped;
  const botUser = Number(row.user_id);
  const declared = new Set<string>(type.permissions ?? []);
  const granted = new Set(grantedPermissions(config).filter((permission) => declared.has(permission)));
  const need = (permission: string) => {
    if (!granted.has(permission)) throw new Error(`This bot was not given the permission '${permission}'.`);
  };
  const channelList = Array.isArray(config.channels) ? config.channels.map(Number) : [];
  const cleanups: (() => void)[] = [];

  const memory = new Map<string, string>();
  const reloadMemory = async () => {
    if (!granted.has("memory")) return;
    const rows = await api.plugin("bots").read("bots_memory", { bot_id: id });
    memory.clear();
    for (const m of rows) memory.set(String(m.key), String(m.value ?? ""));
  };
  const botMemory: BotMemory = {
    get: (key) => { need("memory"); return memory.get(key) ?? null; },
    keys: (prefix = "") => { need("memory"); return [...memory.keys()].filter((key) => key.startsWith(prefix)); },
    set: async (key, value) => {
      need("memory");
      if (!live()) return;
      await api.plugin("bots").call("memory-set", { bot_id: id, key, value });
      memory.set(key, value);
    },
    delete: async (key) => {
      need("memory");
      if (!live()) return;
      await api.plugin("bots").call("memory-delete", { bot_id: id, key });
      memory.delete(key);
    },
  };

  const library: BotLibrary = {
    entries: async () => {
      need("memory");
      return (await api.plugin("bots").read("bots_context"))
        .filter((row) => typeof row.channel_id !== "number" || canSeeChannel(workspaceId, row.channel_id, botUser))
        .map((row) => ({
          channelId: typeof row.channel_id === "number" ? row.channel_id : null, kind: String(row.kind), ref: String(row.ref), title: String(row.title),
          summary: String(row.summary ?? ""), tags: String(row.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean), sourceHash: String(row.source_hash ?? ""),
        }));
    },
    save: async (entry) => {
      need("memory");
      if (!live()) return;
      await api.plugin("bots").call("context-set", {
        bot_id: id, ref: entry.ref, kind: entry.kind, title: entry.title, summary: entry.summary, tags: entry.tags.join(","),
        channel_id: entry.channelId, source_hash: entry.sourceHash,
      });
    },
    remove: async (ref) => {
      need("memory");
      if (live()) await api.plugin("bots").call("context-delete", { ref });
    },
  };

  const botApi = api.forBot(botUser);
  // What the bot shows in each channel (cursor, typing), sent as one state per channel.
  const shown = new Map<number, Record<string, PresenceState>>();
  const setPresence = (channelId: number, key: string, value: PresenceState | null) => {
    const state = { ...shown.get(channelId) };
    if (value === null) delete state[key];
    else state[key] = value;
    if (Object.keys(state).length) shown.set(channelId, state);
    else shown.delete(channelId);
    setBotPresence(workspaceId, botUser, channelId, Object.keys(state).length ? state : null);
  };
  cleanups.push(() => { for (const channelId of [...shown.keys()]) { shown.delete(channelId); setBotPresence(workspaceId, botUser, channelId, null); } });
  const send: BotContext["send"] = async (channelId, text, options) => {
    if (!live()) return;
    await chat.call("post-bot-message", {
      channel_id: channelId, bot_user_id: botUser, body: encodeEmoji(text), thread_id: options?.threadId ?? null,
      buttons: options?.buttons?.length ? JSON.stringify(options.buttons) : null,
    });
  };

  let inCall: number | null = null;
  const leaveCall = () => {
    if (inCall === null) return;
    inCall = null;
    mediaLink(workspaceId)?.setGuest?.(botUser, null);
  };
  cleanups.push(leaveCall);
  const botCall: BotCall = {
    channelOf: (userId) => { need("voice"); return voiceChannelOf(workspaceId, userId); },
    current: () => inCall,
    join: async (channelId, media) => {
      need("voice");
      if (!live()) return;
      const link = mediaLink(workspaceId);
      if (!link?.setGuest) throw new Error("Calls are not available in this workspace.");
      const channel = await context.channel(channelId);
      if (channel?.type !== "voice") throw new Error("That is not a voice channel I can join.");
      const own = ownCall();
      if (own?.workspaceId === workspaceId && own.channelId !== channelId)
        throw new Error("My host is in a call in another channel, and a device can be in one call at a time.");
      const picture = !!media.screen && media.screen.getVideoTracks().length > 0;
      link.setGuest(botUser, {
        channelId,
        streams: { mic: media.mic ?? null, camera: null, screen: media.screen ?? null },
        row: {
          channel_id: channelId, muted: !media.mic, deafened: false, sharing: media.screen ? media.label ?? "Media" : null,
          camera: false, sound_only: !!media.screen && !picture,
        },
      });
      inCall = channelId;
    },
    leave: leaveCall,
  };

  const context: BotContext = {
    workspaceId,
    call: botCall,
    bot: { id: botUser, type: String(row.type), nickname: String(row.nickname), config },
    api: api.plugin("bots"),
    userId: workspace.me!,
    channel: async (channelId: number) => {
      if (!canSeeChannel(workspaceId, channelId, botUser)) return null;
      const [channel] = await api.plugin("channels").read("channels_channels", { id: channelId });
      return channel ? { id: Number(channel.id), name: String(channel.name), type: String(channel.type) } : null;
    },
    channels: async () => {
      const [rows, categories] = await Promise.all([api.plugin("channels").read("channels_channels"), api.plugin("channels").read("channels_categories")]);
      const categoryNames = new Map(categories.map((c) => [Number(c.id), String(c.name)]));
      return rows
        .filter((channel) => canSeeChannel(workspaceId, Number(channel.id), botUser))
        .map((channel) => ({ id: Number(channel.id), name: String(channel.name), type: String(channel.type), category: categoryNames.get(Number(channel.category_id)) }));
    },
    messages: async (channelId: number) => {
      if (!canSeeChannel(workspaceId, channelId, botUser)) return [];
      const result = await chat.call<{ rows: { id: number; author_id: number; body: string; thread_id: number | null; created_at: string }[] }>(
        "list-messages", { channel_id: channelId });
      return result.rows;
    },
    inChannel: (channelId) => (channelList.length === 0 || channelList.includes(channelId))
      && canInChannel(workspaceId, channelId, "send_messages", botUser),
    send,
    post: async (channelId, text, options) => {
      if (!live()) return 0;
      return (await botApi.plugin("chat").call<{ id: number }>("post-message", {
        channel_id: channelId, body: encodeEmoji(text), thread_id: options?.threadId ?? null, action: options?.action === true,
        buttons: options?.buttons?.length ? JSON.stringify(options.buttons) : null,
        steps: options?.steps?.length ? options.steps.join("\n") : null,
      })).id;
    },
    edit: async (messageId, text, buttons) => {
      if (live()) await botApi.plugin("chat").call("edit-message", { message_id: messageId, body: encodeEmoji(text), buttons: buttons === undefined ? null : JSON.stringify(buttons) });
    },
    write: (plugin) => { need(`write:${plugin}`); return botApi.plugin(plugin); },
    log: async (text: string) => { if (live()) log(workspaceId, id, text); },
    openChannel: (channelId: number) => { if (live()) openChannel(workspaceId, channelId); },
    openLink: (url: string) => live() && openLink(url),
    // Rows of channels the bot can't see are left out, as for any member.
    read: async (plugin, table, where) => {
      need(`read:${plugin}`);
      return (await api.plugin(plugin).read(table, where)).filter((row) => typeof row.channel_id !== "number" || canSeeChannel(workspaceId, row.channel_id, botUser));
    },
    onEvent: (plugin, handler) => {
      need(`read:${plugin}`);
      const stop = api.plugin(plugin).onEvent((event) => { if (live() && event) handler(event); });
      cleanups.push(stop);
      return stop;
    },
    member: (userId) => {
      const m = member(workspaceId, userId);
      return { id: m.id, displayName: m.displayName, username: m.username, bot: m.bot };
    },
    granted: (permission) => granted.has(permission),
    cursor: async (channelId, at, glideMs = 300) => {
      if (!live()) return;
      const from = shown.get(channelId)?.cursor as { x: number; y: number } | undefined;
      const steps = from && at && glideMs > 0 ? Math.max(1, Math.round(glideMs / 50)) : 1;
      for (let i = 1; i <= steps && live(); i++) {
        const t = steps === 1 ? 1 : 1 - (1 - i / steps) ** 2;
        setPresence(channelId, "cursor", at && from ? { x: from.x + (at.x - from.x) * t, y: from.y + (at.y - from.y) * t } : at);
        if (i < steps) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    mark: (channelId, key, value) => { if (live()) setPresence(channelId, key, value); },
    marks: (channelId) => presenceOf(workspaceId, channelId).flatMap((peer) =>
      peer.state && typeof peer.state === "object" && !Array.isArray(peer.state)
        ? Object.entries(peer.state).map(([key, value]) => ({ userId: peer.userId, key, value }))
        : []),
    undoWork: async (botIds, from, to) => {
      const ledger = workspaceLedger(workspaceId);
      if (!ledger) throw new Error("This workspace is not open.");
      await ledger.flush();
      const hashes = ledger.log()
        .filter(({ commit, rejected }) => !rejected && commit.as !== undefined && botIds.includes(commit.as) && commit.time >= from && commit.time <= to + 5000)
        .map(({ commit }) => commit.hash).reverse();
      let undone = 0;
      let skipped = 0;
      for (const hash of hashes) {
        try {
          const plan = await planWorkspaceUndo(ledger, hash);
          if (plan.conflicts.length || !plan.operations.length) skipped++;
          else {
            await applyWorkspaceUndo(ledger, plan, false);
            undone++;
          }
        } catch {
          skipped++;
        }
      }
      return { undone, skipped };
    },
    leave: () => { for (const channelId of [...shown.keys()]) { shown.delete(channelId); setBotPresence(workspaceId, botUser, channelId, null); } },
    typing: (channelId, threadId, on) => setPresence(channelId, "typing", on ? threadId ?? 0 : null),
    renameBot: async (botUserId, nickname) => {
      need("spawn");
      const [target] = await api.plugin("bots").read("bots_bots", { user_id: botUserId });
      if (!target || botParent(target) !== botUser) throw new Error("That is not one of my bots.");
      await api.plugin("bots").call("update", { id: target.id, nickname });
      await api.plugin("members").call("set-bot-profile", { user_id: botUserId, bot_type: String(target.type), nickname, bot_number: target.bot_number });
    },
    createBot: async (type, nickname, extra) => {
      need("spawn");
      const kind = botTypeFor(type)?.type;
      if (!kind) throw new Error(`The bot type '${type}' is not installed.`);
      const taken = new Set((await api.plugin("bots").read("bots_bots")).map((row) => Number(row.user_id)));
      let userId = Math.floor(Date.now() * 1000 + Math.random() * 1000);
      while (taken.has(userId)) userId++;
      const allowed = new Set(kind.permissions ?? []);
      const created = await api.plugin("bots").call<{ nickname: string; bot_number: number }>("create", {
        user_id: userId, type, nickname,
        config: JSON.stringify({ ...extra, _permissions: [...granted].filter((p) => allowed.has(p as never) && p !== "spawn"), _parent: botUser }),
      });
      await api.plugin("members").call("set-bot-profile", { user_id: userId, bot_type: type, nickname: created.nickname, bot_number: created.bot_number });
      // The helper gets the roles its leader holds (the policy allows exactly that), so it may do what the leader may.
      for (const held of await api.plugin("roles").read("roles_members", { user_id: botUser }))
        await botApi.plugin("roles").call("assign-role", { user_id: userId, role_id: held.role_id }).catch(() => {});
      return userId;
    },
    secret: async (setting) => {
      const id = Number(config[setting]);
      return id > 0 ? credentialSecret(workspaceId, id) : null;
    },
    memory: botMemory,
    library,
    online: () => {
      need("presence");
      return memberList(workspaceId).map((m) => m.id)
        .filter((userId) => userId === workspace.me || peerStatusOf(workspaceId, userId) === "online");
    },
    can: (userId, permission) => standingOf(workspaceId, userId).permissions.has(permission as Permission),
  };

  const botMayAnswer = async (authorId: number, channelId: number, messageId: number, threadId: number | null) => {
    const related = (await api.plugin("bots").read("bots_bots")).filter((row) => Number(row.user_id) === authorId || Number(row.user_id) === botUser);
    for (const row of related) if (botParent(row) === (Number(row.user_id) === authorId ? botUser : authorId)) return false;
    let chain = 0;
    const earlier = (await context.messages(channelId)).filter((m) => !m.action && m.thread_id === threadId && Number(m.id) < messageId);
    for (const m of earlier.toReversed()) {
      if (!member(workspaceId, m.author_id).bot) break;
      chain++;
    }
    return chain < maxBotChain;
  };

  const handled = new Set<number>();
  const commands = type.commands ?? {};
  if (type.commands || type.mention) {
    // Each event is handled on its own, at the same time as the others: two mentions of one bot run at once (the loop
    // below only orders the messages of one event), so anything per bot must allow several jobs (agents/jobs.ts).
    cleanups.push(chat.onEvent(async (event) => {
      if (!live() || event?.table !== "chat_messages" || event.change !== "insert") return;
      for (const messageId of event.ids) {
        if (handled.has(messageId)) continue;
        handled.add(messageId);
        // Only recent ids matter (older messages are past freshMs anyway): the oldest go, so a long run stays small.
        if (handled.size > 2000) for (const old of [...handled].slice(0, 1000)) handled.delete(old);
        try {
          const { message } = await chat.call<{ message: Record<string, any> }>("get-message", { message_id: messageId });
          if (message?.kind !== "message" || message.deleted === true) continue;
          const authorId = Number(message.author_id);
          if (authorId === botUser) continue;
          const byBot = member(workspaceId, authorId).bot;
          if (Date.now() - Date.parse(String(message.created_at)) > freshMs) continue;
          let parsed = parseBotCommand(String(message.body ?? ""), botUser);
          const channelId = Number(message.channel_id);
          // A bot may speak to this bot only by naming it, not as a relative (a leader and its helpers talk through tasks),
          // and only a few bot messages in a row, so two bots can't keep each other going.
          if (byBot && (parsed?.name !== "" || !(await botMayAnswer(authorId, channelId, messageId, message.thread_id === null ? null : Number(message.thread_id))))) continue;
          // A reply in a thread the bot is part of counts as speaking to it (unless it names another bot, or the bot
          // is a leader's helper, which only works when handed a task).
          if (!parsed && !byBot && type.mention && message.thread_id !== null && !config._parent && !/<@\d+>/.test(String(message.body ?? "")) && context.inChannel(channelId)) {
            const thread = await chat.call<{ rows: { author_id: number }[] }>("list-messages", { channel_id: channelId, thread_id: Number(message.thread_id) });
            const { message: root } = await chat.call<{ message: Record<string, any> }>("get-message", { message_id: Number(message.thread_id) });
            // Several bots in one thread: the one that spoke last answers.
            const lastBot = thread.rows.findLast((m) => member(workspaceId, Number(m.author_id)).bot)?.author_id;
            if ((lastBot === undefined ? Number(root?.author_id) : Number(lastBot)) === botUser)
              parsed = { name: "", args: String(message.body ?? "").trim() };
          }
          if (!parsed || !context.inChannel(channelId)) continue;
          const reply: BotMessageTarget = { channelId, threadId: message.thread_id === null ? null : Number(message.thread_id) };
          const botMessage = {
            id: messageId, channelId, threadId: reply.threadId, authorId, body: String(message.body ?? ""), createdAt: String(message.created_at),
            attachments: (Array.isArray(message.attachments) ? message.attachments : []).map((a: Record<string, unknown>) => ({
              name: String(a.name ?? ""), mime: String(a.mime ?? ""), url: String(a.url ?? ""), thumb: typeof a.thumb === "string" ? a.thumb : null,
            })),
          };
          if (parsed.name === "" && parsed.args && type.mention) {
            context.typing(channelId, reply.threadId, true);
            try {
              const text = await type.mention(context, botMessage, parsed.args);
              if (text) await context.send(channelId, `<@${authorId}> ${text}`, { threadId: reply.threadId });
            } catch (e) {
              const why = e instanceof Error ? e.message : String(e);
              log(workspaceId, id, `Mention failed: ${why}`);
              await context.send(channelId, `<@${authorId}> Something went wrong: ${why}`, { threadId: reply.threadId });
            } finally {
              context.typing(channelId, reply.threadId, false);
            }
            continue;
          }
          await answer(context, commands, parsed, reply, botMessage);
        } catch (e) {
          log(workspaceId, id, `Command failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }));
  }

  try {
    await reloadMemory();
    if (granted.has("memory"))
      cleanups.push(api.plugin("bots").onEvent((event) => { if (live() && event?.table === "bots_memory") void reloadMemory().catch((e) => console.warn("Bot memory not reloaded:", e)); }));
    const stop = await type.start(context);
    const stopAll = () => { cleanups.forEach((cleanup) => cleanup()); if (typeof stop === "function") stop(); };
    if (entry.stopped) stopAll();
    else entry.stop = stopAll;
    if (!entry.stopped) log(workspaceId, id, "Started on this device.");
  } catch (e) {
    cleanups.forEach((cleanup) => cleanup());
    log(workspaceId, id, `Could not start: ${e instanceof Error ? e.message : String(e)}`);
  }
}

type BotMessageTarget = { channelId: number; threadId: number | null };

async function answer(context: BotContext, commands: Record<string, BotCommand>, parsed: { name: string; args: string },
  target: BotMessageTarget, message: Parameters<BotCommand["run"]>[1]["message"]) {
  const ping = `<@${message.authorId}> `;
  const command = commands[parsed.name];
  if (!command) {
    const buttons = Object.keys(commands).map((name) => ({ label: `/${name}`, command: `/${name}` })).slice(0, 12);
    const lines = Object.entries(commands).map(([, c]) => `- \`${c.usage}\`: ${c.help}`).join("\n");
    const lead = parsed.name ? `I don't know \`/${parsed.name}\`. ` : "";
    await context.send(target.channelId, `${ping}${lead}I can do:\n${lines}`, { threadId: target.threadId, buttons });
    return;
  }
  let result;
  try {
    result = await command.run(context, { message, ...commandArgs(parsed.args) });
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (!text.includes("was not given the permission")) throw e;
    await context.send(target.channelId, `${ping}${text}`, { threadId: target.threadId });
    return;
  }
  if (!result) return;
  const text = typeof result === "string" ? result : result.text;
  const buttons = typeof result === "string" ? undefined : result.buttons;
  if (text) await context.send(target.channelId, `${ping}${text}`, { threadId: target.threadId, buttons });
}
