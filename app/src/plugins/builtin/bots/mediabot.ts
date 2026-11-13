import { mediaBotLook, butlerName } from "./identity";
import { MediaPlayer } from "../../../voice/mediaPlayer";
import { desktop } from "../../../core/desktop";
import type { BotContext, BotMessage, BotType } from "../../types";
import {
  describePlayback, findLink, formatTime, looksLikePlaylist, nextIndex, parseLoop, parseSeek, queueText, shuffledAfter, type Loop,
} from "./mediaLogic";

// A paused player stays this long (the bot stays in the call), then leaves. A finished queue leaves at once.
const idleMs = 10 * 60_000;
const maxQueue = 300;

export const mediabot: BotType = {
  look: mediaBotLook,
  randomName: butlerName,
  label: "Media-bot",
  description: "Mention it with a link (YouTube and many other sites, playlists too) and it joins your voice channel and plays it. Needs yt-dlp on its host's computer (desktop app).",
  permissions: ["voice"],
  defaultVolume: 0.05,
  settings: {
    audioOnly: { label: "Stream audio only (no picture)", type: "bool", default: false },
    voiceChannel: { label: "Linked voice channel (used when the person asking is not in a voice channel)", type: "channel", channelType: "voice" },
  },
  commands: {
    play: {
      usage: "/play [link]", help: "Plays a link (a playlist too) in your voice channel, or adds it to the queue while something plays. Without a link, carries on a paused one.",
      run: (context, call) => control(context).play(call.message, call.args, false),
    },
    playnow: {
      usage: "/playnow link", help: "Plays a link at once, replacing the queue.",
      run: (context, call) => control(context).play(call.message, call.args, true),
    },
    queue: {
      usage: "/queue [link]", help: "Shows the queue, or adds a link (a playlist too) to its end.",
      run: (context, call) => control(context).queue(call.message, call.args),
    },
    skip: { usage: "/skip", help: "Plays the next item.", run: (context, call) => control(context).step(call.message, 1) },
    back: { usage: "/back", help: "Plays the previous item.", run: (context, call) => control(context).step(call.message, -1) },
    shuffle: { usage: "/shuffle", help: "Mixes up what is still to come in the queue.", run: (context, call) => control(context).shuffle(call.message) },
    loop: {
      usage: "/loop off|one|queue", help: "Repeats the current item, or the whole queue.",
      run: (context, call) => control(context).loop(call.message, call.args),
    },
    clear: { usage: "/clear", help: "Empties the queue after the current item.", run: (context, call) => control(context).clear(call.message) },
    pause: { usage: "/pause", help: "Pauses.", run: (context, call) => control(context).pause(call.message) },
    restart: { usage: "/restart", help: "Plays the current item again from the start.", run: (context, call) => control(context).restart(call.message) },
    seek: {
      usage: "/seek 1:30", help: "Jumps to a time (1:30, 90, 1m30s) or by a step (+30, -10).",
      run: (context, call) => control(context).seek(call.message, call.args),
    },
    stop: { usage: "/stop", help: "Stops, empties the queue and leaves the call.", run: (context, call) => control(context).stop(call.message) },
    now: { usage: "/now", help: "Shows what is playing.", run: (context) => control(context).now() },
  },
  mention: (context, message, text) => control(context).play(message, text, false),
  start(context) {
    const state = control(context);
    return () => { state.close(); sessions.delete(context); };
  },
};

type Session = ReturnType<typeof makeSession>;
const sessions = new Map<BotContext, Session>();

function control(context: BotContext): Session {
  let session = sessions.get(context);
  if (!session) sessions.set(context, (session = makeSession(context)));
  return session;
}

type Item = { url: string; title: string };

function makeSession(context: BotContext) {
  let player: MediaPlayer | null = null;
  let items: Item[] = [];
  let index = -1;
  let mode: Loop = "off";
  let channelId: number | null = null;
  let loading = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let announce: { channelId: number; threadId: number | null } | null = null;
  // The player whose end was handled already (the ended event can come more than once).
  let advanced: MediaPlayer | null = null;

  const linked = () => Number(context.bot.config.voiceChannel ?? 0) || null;
  const audioOnly = () => context.bot.config.audioOnly === true;
  const title = () => items[index]?.title || "the media";
  const say = (text: string) => announce ? context.send(announce.channelId, text, { threadId: announce.threadId }) : Promise.resolve();

  const closePlayer = () => {
    clearTimeout(idle);
    player?.close();
    player = null;
  };
  const leave = () => {
    loading++;
    closePlayer();
    items = [];
    index = -1;
    context.call.leave();
    channelId = null;
  };
  const watchIdle = () => {
    clearTimeout(idle);
    if (player && (player.paused || player.ended)) idle = setTimeout(leave, idleMs);
  };
  const changed = (source: MediaPlayer | undefined) => {
    if (!source || source !== player) return;
    watchIdle();
    if (source.ended && advanced !== source) {
      advanced = source;
      void advance(false);
    }
  };

  // Whoever asks must be where the bot is: in its call, or anywhere when the bot is in its linked channel.
  const allowed = (authorId: number): string | null => {
    if (!player || channelId === null) return "Nothing is playing. Mention me with a link to start.";
    if (channelId === linked() || context.call.channelOf(authorId) === channelId) return null;
    return "Join the voice channel I am in to control me.";
  };

  // Loads the item at `at` and plays it in `target`. Returns why it could not, or null.
  async function startAt(at: number, target: number): Promise<string | null> {
    const mine = ++loading;
    const item = items[at];
    try {
      const opened: { player?: MediaPlayer } = {};
      const next = (opened.player = await MediaPlayer.open(item.url, audioOnly(), () => changed(opened.player)));
      if (mine !== loading) {
        next.close();
        return "";
      }
      closePlayer();
      player = next;
      index = at;
      if (!item.title || item.title === item.url) item.title = next.info.title;
      const shown = next.picture && !audioOnly();
      // A share, sound only when audio only: its volume is the stream volume, apart from voices.
      const tracks = shown ? [...next.picture!.getVideoTracks(), ...next.sound.getAudioTracks()] : next.sound.getAudioTracks();
      await context.call.join(target, { screen: new MediaStream(tracks), label: item.title.slice(0, 60) });
      channelId = target;
      await next.play();
      watchIdle();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  async function describeStart(target: number): Promise<string> {
    const name = (await context.channel(target))?.name;
    const info = player!.info;
    return `Playing **${title()}**${info.duration ? ` (${formatTime(info.duration)})` : ""}${name ? ` in #${name}` : ""}${info.live ? " (live)" : ""}${items.length > 1 ? ` [${index + 1}/${items.length}]` : ""}.`;
  }

  // The current item is over (or skipped): the next one starts, trying on when one fails.
  async function advance(skipped: boolean, direction = 1): Promise<string | null> {
    if (channelId === null) return null;
    const target = channelId;
    let at: number | null = direction < 0 ? (index > 0 ? index - 1 : mode === "queue" ? items.length - 1 : null) : nextIndex(index, items.length, mode, skipped);
    for (let tried = 0; at !== null && tried < items.length; tried++) {
      const why = await startAt(at, target);
      if (why === null) {
        await say(await describeStart(target));
        return null;
      }
      if (why === "") return null;
      await say(`Could not play **${items[at].title || items[at].url}**: ${why}`);
      at = nextIndex(at, items.length, mode === "one" ? "off" : mode, true);
    }
    if (skipped || direction < 0) return at === null ? (direction < 0 ? "This is the first item." : "There is nothing more in the queue.") : null;
    leave();
    await say("Finished the queue and left the call. Mention me with a link to play more.");
    return null;
  }

  async function expand(link: string): Promise<Item[]> {
    if (!looksLikePlaylist(link)) return [{ url: link, title: "" }];
    const entries = await desktop!.media!.list(link);
    if (entries.length === 0) throw new Error("That playlist has nothing in it.");
    return entries.map((entry) => ({ url: entry.url, title: entry.title }));
  }

  async function add(message: BotMessage, link: string, replace: boolean): Promise<string | null> {
    if (!desktop?.media) return "I can only play links when my host runs the desktop app.";
    const target = context.call.channelOf(message.authorId) ?? linked();
    const active = !!player && !player.ended && channelId !== null;
    if (!replace && active) {
      const refused = allowed(message.authorId);
      if (refused) return refused;
    } else if (target === null) {
      return "Join a voice channel first, or ask an admin to link one in my settings.";
    }
    announce = { channelId: message.channelId, threadId: message.threadId };
    const wait = await context.post(message.channelId, "Looking for the media...", { threadId: message.threadId, action: true });
    const reply = (text: string) => context.edit(wait, `<@${message.authorId}> ${text}`);
    let found: Item[];
    try {
      found = await expand(link);
    } catch (e) {
      await reply(e instanceof Error ? e.message : String(e));
      return null;
    }
    if (!replace && active) {
      const room = maxQueue - items.length;
      items.push(...found.slice(0, Math.max(0, room)));
      await reply(found.length === 1 ? `Added to the queue (${items.length - index - 1} to come).` : `Added ${Math.min(found.length, room)} items to the queue (${items.length - index - 1} to come).`);
      return null;
    }
    items = found.slice(0, maxQueue);
    index = -1;
    const why = await startAt(0, target!);
    if (why === null) await reply(await describeStart(target!));
    else if (why === "") await reply("A newer link replaced this one.");
    else {
      await reply(why);
      if (!player) items = [];
    }
    return null;
  }

  return {
    async play(message: BotMessage, text: string, replace: boolean): Promise<string | null> {
      const link = findLink(text);
      if (link) return add(message, link, replace);
      if (replace) return "Try `/playnow https://...`.";
      if (text.trim() && !text.trim().startsWith("/")) return "Mention me with a link, like `@me https://...`. I also take `/queue`, `/skip`, `/pause`, `/seek`, `/loop`, `/stop` and `/now`.";
      const refused = allowed(message.authorId);
      if (refused) return refused;
      await player!.play();
      return `Playing **${title()}**.`;
    },
    async queue(message: BotMessage, args: string) {
      const link = findLink(args);
      if (link) return add(message, link, false);
      return queueText(items, index, mode);
    },
    async step(message: BotMessage, direction: 1 | -1) {
      const refused = allowed(message.authorId);
      if (refused) return refused;
      return advance(true, direction);
    },
    shuffle(message: BotMessage) {
      const refused = allowed(message.authorId);
      if (refused) return refused;
      items = shuffledAfter(items, index);
      return items.length - index - 1 > 1 ? "Mixed up the queue." : "There is nothing to mix up.";
    },
    loop(message: BotMessage, args: string) {
      const refused = allowed(message.authorId);
      if (refused) return refused;
      const next = parseLoop(args);
      if (!next) return `Looping is ${mode}. Try \`/loop off\`, \`/loop one\` or \`/loop queue\`.`;
      mode = next;
      return next === "off" ? "Not looping." : next === "one" ? "Repeating this one." : "Repeating the queue.";
    },
    clear(message: BotMessage) {
      const refused = allowed(message.authorId);
      if (refused) return refused;
      items = items.slice(0, index + 1);
      return "Cleared what was to come.";
    },
    async pause(message: BotMessage) {
      const refused = allowed(message.authorId);
      if (refused) return refused;
      player!.pause();
      return `Paused at ${formatTime(player!.position)}.`;
    },
    async restart(message: BotMessage) {
      const refused = allowed(message.authorId);
      if (refused) return refused;
      player!.seek(0);
      await player!.play();
      return `Playing **${title()}** from the start.`;
    },
    seek(message: BotMessage, args: string) {
      const refused = allowed(message.authorId);
      if (refused) return refused;
      if (player!.info.live) return "A live stream can't be moved.";
      const target = parseSeek(args);
      if (!target) return "Try `/seek 1:30`, `/seek 90`, `/seek +30` or `/seek -10`.";
      player!.seek(target.relative ? player!.position + target.seconds : target.seconds);
      return `Moved to ${formatTime(player!.position)}.`;
    },
    stop(message: BotMessage) {
      const refused = allowed(message.authorId);
      if (refused) return refused;
      leave();
      return "Stopped.";
    },
    now() {
      if (!player) return "Nothing is playing.";
      const state = player.ended ? "ended" : player.buffering ? "loading" : player.paused ? "paused" : "playing";
      return describePlayback(title(), player.position, player.info.duration, state);
    },
    close: leave,
  };
}
