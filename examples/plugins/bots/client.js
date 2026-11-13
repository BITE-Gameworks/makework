function reverseText(text) {
  const parts = text.split(/(:[a-z0-9_+-]+:)/gi);
  return parts.map((part) => /^:[a-z0-9_+-]+:$/i.test(part) ? part : [...part].reverse().join(""))
    .reverse().join("");
}

function workspaceLink(text) {
  const markdown = text.match(/\]\(\s*<?(makework:\/\/[^)\s>"]+)/i)?.[1];
  const plain = text.match(/makework:\/\/[^\s<>)"]+/i)?.[0];
  const link = markdown ?? plain;
  if (!link) return null;
  // The sentence's punctuation after the link. A loop, not a pattern like /x+$/: without a start anchor that is tried
  // again from every position.
  let end = link.length;
  while (end > 0 && ".,!?;".includes(link[end - 1])) end--;
  return link.slice(0, end);
}

function poll(context, channels, run) {
  let stopped = false;
  let timer;
  const seen = new Set();
  const cursors = new Map();
  const tick = async () => {
    if (stopped) return;
    try {
      for (const channel of channels) {
        const messages = await context.messages(channel);
        if (!cursors.has(channel)) {
          cursors.set(channel, messages.reduce((latest, message) => Math.max(latest, Number(message.id)), 0));
          for (const message of messages) seen.add(message.id);
          continue;
        }
        const fresh = messages.filter((message) => Number(message.id) > (cursors.get(channel) || 0) && !seen.has(message.id));
        for (const message of fresh) seen.add(message.id);
        if (fresh.length) {
          cursors.set(channel, fresh.reduce((latest, message) => Math.max(latest, Number(message.id)), cursors.get(channel) || 0));
          await run(fresh);
        }
      }
    } catch (error) {
      await context.log(`Polling failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!stopped) timer = setTimeout(tick, 2_000);
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

const reply = {
  label: "Reply",
  description: "Replies to a mention with the mentioned text reversed.",
  settings: { channel: { label: "Channel id", type: "number" } },
  start(context) {
    const channel = Number(context.bot.config.channel ?? 0);
    if (!channel) return () => {};
    return poll(context, [channel], async (messages) => {
      for (const message of messages) {
        const mention = `<@${context.bot.id}>`;
        if (message.author_id === context.bot.id || !message.body.includes(mention)) continue;
        const text = message.body.replace(mention, "").trim();
        if (text) await context.send(channel, reverseText(text));
      }
    });
  },
};

const announcer = {
  label: "Announcer",
  description: "Sends a configured message on a repeat interval.",
  settings: {
    channel: { label: "Channel id", type: "number" },
    message: { label: "Message", type: "text" },
    repeat: { label: "Repeat seconds", type: "number", default: 3600 },
  },
  async start(context) {
    const channel = Number(context.bot.config.channel ?? 0);
    const message = String(context.bot.config.message ?? "");
    const repeat = Math.max(10, Number(context.bot.config.repeat ?? 3600)) * 1000;
    let stopped = false;
    let timer;
    const send = async () => {
      if (stopped || !message) return;
      await context.send(channel, message);
      await context.log(`Announced in channel ${channel}.`);
      if (!stopped) timer = setTimeout(send, repeat);
    };
    // The channel remembers the last announcement, so a restart or another device waits for the rest of the interval.
    const mine = (await context.messages(channel)).filter((m) => m.author_id === context.bot.id && m.body === message);
    const last = mine.length ? Date.parse(mine[mine.length - 1].created_at ?? "") : Number.NaN;
    const wait = Number.isFinite(last) ? Math.max(0, last + repeat - Date.now()) : 0;
    if (wait > 0) timer = setTimeout(send, wait);
    else await send();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  },
};

const tester = {
  label: "Tester",
  description: "Opens a MakeWork link when mentioned in its configured channel.",
  settings: { channel: { label: "Channel id", type: "number" } },
  start(context) {
    const channel = Number(context.bot.config.channel ?? 0);
    if (!channel) return () => {};
    void context.log("Tester is ready; mention it with a workspace link to open it.");
    return poll(context, [channel], async (messages) => {
      for (const message of messages) {
        const mention = `<@${context.bot.id}>`;
        if (message.author_id === context.bot.id || !message.body.includes(mention)) continue;
        const link = workspaceLink(message.body);
        if (link && context.openLink(link))
          await context.send(channel, `Opened ${link}`);
        else
          await context.send(channel, "I couldn't open that link. Please use a valid MakeWork workspace link.");
      }
    });
  },
  async fuzz(context) {
    const channel = Number(context.bot.config.channel ?? 0);
    await context.send(channel, "Tester fuzz run completed.");
  },
};

export default {
  manifest: {
    id: "example.bots",
    name: "Bot examples",
    version: "1.0.1",
    description: "Example Reply, Announcer and Tester bot types.",
  },
  bots: { reply, announcer, tester },
};
