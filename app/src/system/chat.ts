// Messages for every chat channel on the server. Text can't contain emoji (backend rule), so clients
// send them as shortcodes. On a member's device, text goes into the ledger sealed with the channel's key and comes out
// opened (ADR 0021, `services.chat`); without the service (nodes, tests) it is stored and listed as it is.
import type { MockPlugin } from "./backend";
import { groupRows, type JsonRow } from "./data";
import { InvalidRequest } from "./errors";

// At most 12 buttons with short labels and a command each; anything else is dropped.
function cleanButtons(value: unknown): string | null {
  try {
    const list = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(list)) return null;
    const clean = list.slice(0, 12).map((b) => ({ label: String(b?.label ?? "").slice(0, 40), command: String(b?.command ?? "").slice(0, 200), ...(b?.input === true ? { input: true } : {}) }))
      .filter((b) => b.label && b.command.startsWith("/"));
    return clean.length ? JSON.stringify(clean) : null;
  } catch {
    return null;
  }
}

export const chat: MockPlugin = {
  manifest: {
    name: "chat",
    version: "1.0.0",
    description: "Text channels with threads, reactions, attachments and polls.",
    tables: [
      {
        name: "chat_messages", parent: null,
        columns: {
          channel_id: "bigint", author_id: "bigint", thread_id: "bigint", kind: "text", body: "text", created_at: "timestamp",
          edited_at: "timestamp", deleted: "bool",
          // Buttons a bot adds: JSON [{ label, command }]. Clicking one posts "<@bot> command" as the clicking member.
          buttons: "text",
          // A bot's note about what it is doing (shown small and in italics).
          action: "bool",
          // What a bot did before it answered: operations one per line, shown as "Performed N operations" that expands.
          steps: "text",
          // A thread reply also shown in the channel.
          in_channel: "bool",
        },
      },
      { name: "chat_reactions", parent: "chat_messages", columns: { message_id: "bigint", user_id: "bigint", code: "text" } },
      {
        name: "chat_attachments", parent: "chat_messages",
        columns: { message_id: "bigint", name: "text", mime: "text", size: "bigint", url: "text", thumb: "text", width: "int", height: "int" },
      },
      { name: "chat_polls", parent: "chat_messages", columns: { message_id: "bigint", multiple: "bool" } },
      { name: "chat_poll_options", parent: "chat_messages", columns: { message_id: "bigint", label: "text", position: "int" } },
      { name: "chat_poll_votes", parent: "chat_poll_options", columns: { option_id: "bigint", user_id: "bigint" } },
      {
        name: "chat_pins", parent: "chat_messages",
        columns: { message_id: "bigint", channel_id: "bigint", pinned_by: "bigint", created_at: "timestamp" },
      },
      // A channel's keys by epoch (`check` tells a key given to someone is this one), each sealed to the members who
      // may read it (p2p/chatKeys.ts).
      { name: "chat_keys", parent: null, columns: { channel_id: "bigint", epoch: "int", check: "text", created_by: "bigint", created_at: "timestamp" } },
      {
        name: "chat_key_grants", parent: null,
        columns: { channel_id: "bigint", epoch: "int", user_id: "bigint", sealed: "text", granted_by: "bigint" },
      },
    ],
  },

  register({ data, services, onApi, onApiRead }) {
    const keys = services.chat;
    const seal = (channelId: unknown, authorId: unknown, text: unknown) =>
      keys && typeof text === "string" && text ? keys.seal(Number(channelId), Number(authorId), text) : text;
    // The text and whether it stayed locked (no key on this device).
    const open = (channelId: unknown, authorId: unknown, text: unknown): [unknown, boolean] => {
      if (!keys || typeof text !== "string" || !text) return [text, false];
      const opened = keys.open(Number(channelId), Number(authorId), text);
      return opened === null ? ["", true] : [opened, false];
    };
    // Guests don't get chat from before they joined.
    const forViewer = (rows: JsonRow[], userId: number) => {
      const since = keys?.guestSince(userId) ?? null;
      return since === null ? rows : rows.filter((m) => Date.parse(String(m.created_at)) >= since);
    };
    const message = (id: unknown) => {
      const [row] = data.select("chat_messages", { id: id as number });
      if (!row) throw new InvalidRequest(`Unknown message ${id}`);
      return row;
    };
    const ownMessage = (id: unknown, userId: number) => {
      const row = message(id);
      if (row.author_id !== userId) throw new InvalidRequest("Not your message.");
      if (row.deleted === true) throw new InvalidRequest("That message was deleted.");
      return row;
    };
    // At most 40 operations of 200 characters; blank when there are none.
    const cleanSteps = (value: unknown): string | null => {
      const lines = String(value ?? "").split("\n").map((l) => l.trim().slice(0, 200)).filter(Boolean).slice(0, 40);
      return lines.length ? lines.join("\n") : null;
    };
    const live = (rows: JsonRow[]) => rows.filter((m) => m.deleted !== true);

    const pollOf = (messageId: number) => {
      const poll = data.select("chat_messages", { id: messageId })[0];
      return {
        multiple: data.select("chat_polls", { message_id: messageId })[0]?.multiple === true,
        options: data.select("chat_poll_options", { message_id: messageId })
          .sort((a, b) => Number(a.position) - Number(b.position))
          .map((o) => {
            const users = data.select("chat_poll_votes", { option_id: o.id }).map((v) => Number(v.user_id));
            return { id: o.id, label: open(poll?.channel_id, poll?.author_id, o.label)[0], count: users.length, users };
          }),
      };
    };

    // What a thread reply shown in the channel says it answers.
    const parentOf = (id: unknown) => {
      const parent = data.select("chat_messages", { id: id as number })[0];
      if (!parent || parent.deleted === true) return { author_id: null, body: "" };
      return { author_id: parent.author_id, body: open(parent.channel_id, parent.author_id, parent.body)[0] };
    };

    // Each table read once per call, grouped by message (groupRows).
    const withDetails = (rows: JsonRow[]) => {
      if (rows.length === 0) return [];
      const replies = groupRows(live(data.select("chat_messages")).filter((m) => m.thread_id !== null), "thread_id");
      const reactions = groupRows(data.select("chat_reactions"), "message_id");
      const attachments = groupRows(data.select("chat_attachments"), "message_id");
      const pins = groupRows(data.select("chat_pins"), "message_id");
      return rows.map((row) => {
        const thread = replies.get(row.id) ?? [];
        const codes = new Map<string, number[]>();
        for (const r of reactions.get(row.id) ?? []) codes.set(String(r.code), [...(codes.get(String(r.code)) ?? []), Number(r.user_id)]);
        const [body, locked] = open(row.channel_id, row.author_id, row.body);
        return {
          ...row,
          body,
          steps: open(row.channel_id, row.author_id, row.steps)[0],
          // Sealed with a key this device doesn't have (yet).
          locked,
          reply_count: thread.length,
          last_reply_at: thread.at(-1)?.created_at ?? null,
          // Who took part in the thread, most recent first (shown as avatars by the reply button).
          repliers: [...new Set(thread.map((m) => Number(m.author_id)).reverse())].slice(0, 5),
          reactions: [...codes].map(([code, users]) => ({ code, count: users.length, users })),
          attachments: (attachments.get(row.id) ?? []).map((a) => ({
            ...a, name: open(row.channel_id, row.author_id, a.name)[0] || "Encrypted file", thumb: open(row.channel_id, row.author_id, a.thumb)[0] || null,
          })),
          poll: row.kind === "poll" ? pollOf(row.id) : null,
          thread_parent: row.in_channel === true && row.thread_id !== null ? parentOf(row.thread_id) : null,
          pinned_by: pins.get(row.id)?.[0]?.pinned_by ?? null,
        };
      });
    };

    onApi("list-messages", "Lists a channel's messages (with thread replies also sent in the channel), or one thread's replies, oldest first, with reactions, attachments and reply counts: { rows }.",
      [
        { name: "channel_id", type: "bigint", description: "The channel." },
        { name: "thread_id", type: "bigint", required: false, description: "A message id to list its replies instead." },
      ],
      (r) => {
        const rows = r.args.thread_id == null
          ? data.select("chat_messages", { channel_id: r.args.channel_id }).filter((m) => m.thread_id === null || m.in_channel === true)
          : data.select("chat_messages", { channel_id: r.args.channel_id, thread_id: r.args.thread_id });
        return { rows: withDetails(forViewer(live(rows), r.userId)) };
      });

    onApi("list-pins", "A channel's pinned messages, most recently pinned first, with details: { rows }.",
      [{ name: "channel_id", type: "bigint", description: "The channel." }],
      (r) => {
        const pins = data.select("chat_pins", { channel_id: r.args.channel_id })
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return { rows: withDetails(forViewer(live(pins.flatMap((p) => data.select("chat_messages", { id: p.message_id }))), r.userId)) };
      });

    // Who may pin is the workspace's policy (manage_messages on serverless workspaces).
    onApi("pin-message", "Pins a message to its channel, or unpins it with pin: false; returns { changed }.",
      [
        { name: "message_id", type: "bigint", description: "The message." },
        { name: "pin", type: "bool", required: false, description: "false to unpin; pins by default." },
      ],
      (r) => {
        const row = message(r.args.message_id);
        const pinned = data.select("chat_pins", { message_id: row.id }).length > 0;
        if (r.args.pin === false) return { changed: pinned && data.delete("chat_pins", { message_id: row.id }) > 0 };
        if (pinned) return { changed: false };
        if (row.deleted === true) throw new InvalidRequest("That message was deleted.");
        data.insert("chat_pins", { message_id: row.id, channel_id: row.channel_id, pinned_by: r.userId, created_at: new Date().toISOString() });
        return { changed: true };
      });

    onApi("get-message", "One message with its details, also a deleted one (deleted: true): { message }.",
      [{ name: "message_id", type: "bigint", description: "The message." }],
      (r) => {
        const row = message(r.args.message_id);
        if (forViewer([row], r.userId).length === 0) throw new InvalidRequest("That message is from before you joined.");
        return { message: withDetails([row])[0] };
      });

    onApi("post-message", "Posts a message as the signed-in user; returns its id.",
      [
        { name: "channel_id", type: "bigint", description: "The channel." },
        { name: "body", type: "text", description: "Markdown text; emoji as :shortcodes:." },
        { name: "thread_id", type: "bigint", required: false, description: "Reply to this message's thread." },
        { name: "action", type: "bool", required: false, description: "A note about what a bot is doing: shown small and in italics." },
        { name: "buttons", type: "text", required: false, description: "JSON [{ label, command, input? }] buttons a bot adds." },
        { name: "steps", type: "text", required: false, description: "A bot's operations, one per line." },
        { name: "in_channel", type: "bool", required: false, description: "A thread reply also shown in the channel." },
      ],
      (r) => {
        if (r.args.thread_id !== null) message(r.args.thread_id);
        return {
          id: data.insert("chat_messages", {
            channel_id: r.args.channel_id, author_id: r.userId, thread_id: r.args.thread_id, kind: "message",
            body: seal(r.args.channel_id, r.userId, r.args.body), created_at: new Date().toISOString(),
            ...(r.args.action === true ? { action: true } : {}), ...(r.args.buttons ? { buttons: cleanButtons(r.args.buttons) } : {}),
            ...(r.args.steps ? { steps: seal(r.args.channel_id, r.userId, cleanSteps(r.args.steps)) } : {}),
            ...(r.args.in_channel === true && r.args.thread_id !== null ? { in_channel: true } : {}),
          }),
        };
      });

    onApi("post-bot-message", "Posts a message for a bot whose host is the signed-in user.", [
      { name: "channel_id", type: "bigint" }, { name: "bot_user_id", type: "bigint" },
      { name: "body", type: "text" }, { name: "thread_id", type: "bigint", required: false },
      { name: "buttons", type: "text", required: false },
    ], (r) => {
      if (r.args.thread_id !== null) message(r.args.thread_id);
      return {
        id: data.insert("chat_messages", {
          channel_id: r.args.channel_id, author_id: r.args.bot_user_id, thread_id: r.args.thread_id, kind: "message",
          body: seal(r.args.channel_id, r.args.bot_user_id, r.args.body), created_at: new Date().toISOString(), buttons: cleanButtons(r.args.buttons),
        }),
      };
    });

    onApi("post-leave", "Posts the signed-in user's \"left the workspace\" message; returns its id.",
      [{ name: "channel_id", type: "bigint", description: "The workspace's welcome channel." }],
      (r) => ({
        id: data.insert("chat_messages", {
          channel_id: r.args.channel_id, author_id: r.userId, thread_id: null, kind: "leave", body: "", created_at: new Date().toISOString(),
        }),
      }));

    // Their profile is gone after a kick, so the note keeps their name: the body is JSON { user_id, name, ban? }.
    onApi("post-kick", "Posts \"<member> was kicked\" (or banned) by the signed-in user; returns its id.",
      [
        { name: "channel_id", type: "bigint", description: "The workspace's welcome channel." },
        { name: "user_id", type: "bigint", description: "The member who was kicked." },
        { name: "name", type: "text", description: "Their display name." },
        { name: "ban", type: "bool", required: false, description: "They were banned, not only kicked." },
      ],
      (r) => ({
        id: data.insert("chat_messages", {
          channel_id: r.args.channel_id, author_id: r.userId, thread_id: null, kind: "kick",
          body: JSON.stringify({ user_id: r.args.user_id, name: String(r.args.name).slice(0, 64), ...(r.args.ban === true && { ban: true }) }),
          created_at: new Date().toISOString(),
        }),
      }));

    onApi("post-join", "Posts the signed-in user's \"joined the workspace\" message; returns its id.",
      [{ name: "channel_id", type: "bigint", description: "The workspace's welcome channel." }],
      (r) => ({
        id: data.insert("chat_messages", {
          channel_id: r.args.channel_id, author_id: r.userId, thread_id: null, kind: "join", body: "", created_at: new Date().toISOString(),
        }),
      }));

    onApi("edit-message", "Changes the text of one of the signed-in user's messages and sets edited_at; returns { updated }.",
      [
        { name: "message_id", type: "bigint", description: "The message." },
        { name: "body", type: "text", description: "Markdown text; emoji as :shortcodes:." },
        { name: "buttons", type: "text", required: false, description: "Replaces a bot message's buttons; an empty text removes them." },
      ],
      (r) => {
        const row = ownMessage(r.args.message_id, r.userId);
        if (["join", "leave", "kick", "move"].includes(String(row.kind))) throw new InvalidRequest("Join, leave, kick and move notes can't be edited.");
        if (!String(r.args.body).trim() && data.select("chat_attachments", { message_id: row.id }).length === 0)
          throw new InvalidRequest("'body' can't be empty.");
        return { updated: data.update("chat_messages", {
          body: seal(row.channel_id, row.author_id, r.args.body), edited_at: new Date().toISOString(), ...(r.args.buttons !== null ? { buttons: cleanButtons(r.args.buttons) } : {}),
        }, { id: row.id }) };
      });

    // Other people's messages need the manage_messages permission, which the workspace's policy checks.
    onApi("delete-message", "Deletes a message (kept, marked deleted); returns { deleted }.",
      [{ name: "message_id", type: "bigint", description: "The message." }],
      (r) => ({ deleted: data.update("chat_messages", { deleted: true }, { id: message(r.args.message_id).id }) }));

    onApi("attach", "Adds an attachment to the signed-in user's message; returns its id.",
      [
        { name: "message_id", type: "bigint", description: "The message." },
        { name: "name", type: "text", description: "File name." },
        { name: "mime", type: "text", description: "Media type." },
        { name: "size", type: "bigint", description: "Size in bytes." },
        { name: "url", type: "text", required: false, description: "Where the content can be downloaded." },
        { name: "width", type: "int", required: false, description: "Image width in px." },
        { name: "height", type: "int", required: false, description: "Image height in px." },
        { name: "thumb", type: "text", required: false, description: "A small preview image (data URL) for images." },
      ],
      (r) => {
        const row = message(r.args.message_id);
        if (row.author_id !== r.userId) throw new InvalidRequest("Not your message.");
        return { id: data.insert("chat_attachments", {
          ...r.args, name: seal(row.channel_id, row.author_id, r.args.name), thumb: seal(row.channel_id, row.author_id, r.args.thumb),
        }) };
      });

    onApi("detach", "Removes an attachment from the signed-in user's message; a message left without text or "
      + "attachments is deleted. Returns { removed }.",
      [{ name: "attachment_id", type: "bigint", description: "The attachment." }],
      (r) => {
        const attachment = data.select("chat_attachments", { id: r.args.attachment_id })[0];
        if (!attachment) throw new InvalidRequest(`Unknown attachment ${r.args.attachment_id}`);
        const row = ownMessage(attachment.message_id, r.userId);
        const removed = data.delete("chat_attachments", { id: attachment.id });
        if (!String(row.body).trim() && data.select("chat_attachments", { message_id: row.id }).length === 0)
          data.update("chat_messages", { deleted: true }, { id: row.id });
        return { removed };
      });

    onApi("react", "Toggles the signed-in user's reaction on a message; returns { added }.",
      [
        { name: "message_id", type: "bigint", description: "The message." },
        { name: "code", type: "text", description: "Emoji shortcode without colons, e.g. smile." },
      ],
      (r) => {
        message(r.args.message_id);
        const mine = { message_id: r.args.message_id, user_id: r.userId, code: r.args.code };
        if (data.select("chat_reactions", mine).length > 0) {
          data.delete("chat_reactions", mine);
          return { added: false };
        }
        data.insert("chat_reactions", mine);
        return { added: true };
      });

    onApi("post-poll", "Posts a poll as the signed-in user; returns its id. The question is the message body.",
      [
        { name: "channel_id", type: "bigint", description: "The channel." },
        { name: "question", type: "text", description: "Markdown; emoji as :shortcodes:." },
        { name: "options", type: "text", description: "The answers, one per line, 2 to 10." },
        { name: "multiple", type: "bool", required: false, description: "Voters may pick several answers." },
        { name: "thread_id", type: "bigint", required: false, description: "Post it in this message's thread." },
      ],
      (r) => {
        const options = String(r.args.options).split("\n").map((o) => o.trim()).filter(Boolean);
        if (!String(r.args.question)) throw new InvalidRequest("'question' can't be empty.");
        if (options.length < 2 || options.length > 10) throw new InvalidRequest("A poll needs 2 to 10 answers.");
        if (r.args.thread_id !== null) message(r.args.thread_id);
        const id = data.insert("chat_messages", {
          channel_id: r.args.channel_id, author_id: r.userId, thread_id: r.args.thread_id, kind: "poll",
          body: seal(r.args.channel_id, r.userId, r.args.question), created_at: new Date().toISOString(),
        });
        data.insert("chat_polls", { message_id: id, multiple: r.args.multiple === true });
        options.forEach((label, position) => data.insert("chat_poll_options", { message_id: id, label: seal(r.args.channel_id, r.userId, label), position }));
        return { id };
      });

    onApi("vote", "Toggles the signed-in user's vote for a poll answer; in single-answer polls it replaces their other vote. Returns { voted }.",
      [{ name: "option_id", type: "bigint", description: "The answer." }],
      (r) => {
        const [option] = data.select("chat_poll_options", { id: r.args.option_id as number });
        if (!option) throw new InvalidRequest(`Unknown answer ${r.args.option_id}`);
        const mine = { option_id: option.id, user_id: r.userId };
        if (data.select("chat_poll_votes", mine).length > 0) {
          data.delete("chat_poll_votes", mine);
          return { voted: false };
        }
        if (!pollOf(Number(option.message_id)).multiple)
          for (const other of data.select("chat_poll_options", { message_id: option.message_id as number }))
            data.delete("chat_poll_votes", { option_id: other.id, user_id: r.userId });
        data.insert("chat_poll_votes", mine);
        return { voted: true };
      });

    onApi("edit-poll", "Edits one of the signed-in user's polls. options is a JSON array of { id?, label }; existing option ids retain votes. Returns { updated }.",
      [
        { name: "message_id", type: "bigint", description: "The poll message." },
        { name: "question", type: "text", description: "Markdown; emoji as :shortcodes:." },
        { name: "options", type: "text", description: "JSON answers: [{ id?, label }], 2 to 10." },
        { name: "multiple", type: "bool", required: false, description: "Voters may pick several answers." },
      ],
      (r) => {
        const row = ownMessage(r.args.message_id, r.userId);
        if (row.kind !== "poll") throw new InvalidRequest("That message isn't a poll.");
        let options: { id?: number; label: string }[];
        try {
          options = JSON.parse(String(r.args.options));
        } catch {
          throw new InvalidRequest("'options' must be valid JSON.");
        }
        if (!Array.isArray(options) || options.length < 2 || options.length > 10
          || options.some((option) => !option || typeof option !== "object" || typeof option.label !== "string" || !option.label.trim()))
          throw new InvalidRequest("A poll needs 2 to 10 answers.");
        if (!String(r.args.question).trim()) throw new InvalidRequest("'question' can't be empty.");
        const ids = options.flatMap((option) => option.id === undefined ? [] : [Number(option.id)]);
        if (ids.some((id) => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length)
          throw new InvalidRequest("A poll answer can only appear once.");

        const existing = data.select("chat_poll_options", { message_id: row.id });
        const byId = new Map(existing.map((option) => [Number(option.id), option]));
        const kept = new Set<number>();
        options.forEach((option, position) => {
          const id = option.id === undefined ? undefined : Number(option.id);
          const current = id === undefined ? undefined : byId.get(id);
          if (id !== undefined && !current) throw new InvalidRequest("An answer doesn't belong to this poll.");
          if (current) {
            kept.add(id!);
            data.update("chat_poll_options", { label: seal(row.channel_id, row.author_id, option.label.trim()), position }, { id });
          } else data.insert("chat_poll_options", { message_id: row.id, label: seal(row.channel_id, row.author_id, option.label.trim()), position });
        });
        for (const option of existing) {
          if (kept.has(Number(option.id))) continue;
          data.delete("chat_poll_votes", { option_id: option.id });
          data.delete("chat_poll_options", { id: option.id });
        }
        data.update("chat_polls", { multiple: r.args.multiple === true }, { message_id: row.id });
        return { updated: data.update("chat_messages", { body: seal(row.channel_id, row.author_id, r.args.question), edited_at: new Date().toISOString() }, { id: row.id }) };
      });

    // A channel's next key with its grants, in one commit: a second key made at the same time is refused whole.
    onApi("add-chat-key", "Records a channel's next key epoch and grants it; returns { id }.", [
      { name: "channel_id", type: "bigint" }, { name: "epoch", type: "int" }, { name: "check", type: "text" },
      { name: "created_at", type: "timestamp" }, { name: "grants", type: "text", description: "JSON [{ user_id, sealed }]." },
    ], (r) => {
      const at = r.args.created_at;
      const id = data.insert("chat_keys", {
        channel_id: r.args.channel_id, epoch: r.args.epoch, check: r.args.check, created_by: r.userId,
        created_at: at instanceof Date ? at.toISOString() : at,
      });
      for (const g of grantList(r.args.grants))
        data.insert("chat_key_grants", { channel_id: r.args.channel_id, epoch: r.args.epoch, user_id: g.user_id, sealed: g.sealed, granted_by: r.userId });
      return { id };
    });
    onApi("grant-chat-keys", "Gives channel keys to members who may read them; returns { granted }.", [
      { name: "grants", type: "text", description: "JSON [{ channel_id, epoch, user_id, sealed }]." },
    ], (r) => {
      const list = grantList(r.args.grants);
      for (const g of list)
        data.insert("chat_key_grants", { channel_id: g.channel_id, epoch: g.epoch, user_id: g.user_id, sealed: g.sealed, granted_by: r.userId });
      return { granted: list.length };
    });

    // Raw reads (bots, agents) get text opened like list-messages, and guests no messages from before they joined.
    onApiRead((r) => {
      const rows = data.select(r.table, r.where);
      if (!keys) return rows;
      const of = (messageId: unknown) => data.select("chat_messages", { id: messageId as number })[0];
      const text = (m: JsonRow | undefined, value: unknown) => (m ? open(m.channel_id, m.author_id, value)[0] : value);
      switch (r.table) {
        case "chat_messages":
          return forViewer(rows, r.userId).map((m) => ({ ...m, body: text(m, m.body), steps: text(m, m.steps) }));
        case "chat_attachments":
          return rows.map((a) => ({ ...a, name: text(of(a.message_id), a.name), thumb: text(of(a.message_id), a.thumb) }));
        case "chat_poll_options":
          return rows.map((o) => ({ ...o, label: text(of(o.message_id), o.label) }));
        default:
          return rows;
      }
    });
  },
};

type Grant = { channel_id?: number; epoch?: number; user_id: number; sealed: string };

function grantList(text: unknown): Grant[] {
  try {
    const list: unknown = JSON.parse(String(text));
    if (Array.isArray(list) && list.length <= 2000 && list.every((g) => g && Number.isSafeInteger(g.user_id) && typeof g.sealed === "string"))
      return list as Grant[];
  } catch {
    // Reported below.
  }
  throw new InvalidRequest("'grants' must be a JSON list of { user_id, sealed }.");
}
