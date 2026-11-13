// Watch parties: members watch video files from a files channel together, each playing their own copy, held in a
// voice channel. The rows keep the playlist and the last play, pause or seek, so members joining late start in the
// right place; while the party plays, members keep each other in step over the voice channel's events (watch/sync.ts).
import type { MockPlugin } from "./backend";
import type { JsonRow } from "./data";
import { InvalidRequest } from "./errors";

const contentRef = /^mwc:[0-9a-f]{64}$/;
export const maxPartyItems = 50;

export const watch: MockPlugin = {
  manifest: {
    name: "watch",
    version: "1.0.0",
    description: "Watch parties: video files played on every member's device in step, in a voice channel.",
    tables: [
      {
        name: "watch_parties", parent: null,
        columns: {
          // The voice channel it is held in, and the chat channel and message that announced it.
          channel_id: "bigint", chat_channel_id: "bigint", message_id: "bigint",
          host_id: "bigint", title: "text", starts_at: "timestamp", created_at: "timestamp", ended: "bool",
          // The last play, pause, seek or change of video: which item, where in it (seconds), and when.
          item: "int", playing: "bool", position: "decimal", changed_at: "timestamp", changed_by: "bigint",
        },
      },
      {
        name: "watch_items", parent: "watch_parties",
        columns: { party_id: "bigint", file_id: "bigint", name: "text", url: "text", mime: "text", size: "bigint", position: "int" },
      },
      { name: "watch_guests", parent: "watch_parties", columns: { party_id: "bigint", user_id: "bigint" } },
    ],
  },

  register({ data, onApi, onApiRead }) {
    const party = (id: unknown) => {
      const [row] = data.select("watch_parties", { id: id as number });
      if (!row) throw new InvalidRequest(`Unknown watch party ${id}`);
      return row;
    };
    const items = (partyId: number) => data.select("watch_items", { party_id: partyId }).sort((a, b) => Number(a.position) - Number(b.position));
    const details = (row: JsonRow) => ({
      ...row,
      items: items(row.id),
      guests: data.select("watch_guests", { party_id: row.id }).map((g) => Number(g.user_id)),
    });

    onApi("create-party", "Plans a watch party in a voice channel with a playlist of video files; returns its id.",
      [
        { name: "channel_id", type: "bigint", description: "The voice channel it is held in." },
        { name: "chat_channel_id", type: "bigint", description: "The chat channel it is announced in." },
        { name: "title", type: "text", description: "What is watched." },
        { name: "starts_at", type: "timestamp", description: "When it starts." },
        { name: "items", type: "text", description: "JSON [{ file_id, name, url, mime, size }], in playing order." },
      ],
      (r) => {
        let list: { file_id: number; name: string; url: string; mime: string; size: number }[];
        try {
          list = JSON.parse(String(r.args.items));
        } catch {
          throw new InvalidRequest("'items' must be JSON.");
        }
        if (!Array.isArray(list) || list.length === 0) throw new InvalidRequest("Pick at least one video.");
        if (list.length > maxPartyItems) throw new InvalidRequest(`At most ${maxPartyItems} videos.`);
        if (list.some((i) => !contentRef.test(String(i.url)))) throw new InvalidRequest("Every video must be content (mwc:...).");
        const title = String(r.args.title ?? "").trim();
        if (!title) throw new InvalidRequest("'title' can't be empty.");
        const now = new Date().toISOString();
        const startsAt = new Date(r.args.starts_at as string | number | Date);
        if (Number.isNaN(startsAt.getTime())) throw new InvalidRequest("'starts_at' must be a time.");
        const id = data.insert("watch_parties", {
          channel_id: r.args.channel_id, chat_channel_id: r.args.chat_channel_id, message_id: null, host_id: r.userId, title,
          starts_at: startsAt.toISOString(), created_at: now, ended: false, item: 0, playing: false, position: 0, changed_at: now, changed_by: r.userId,
        });
        list.forEach((i, position) => data.insert("watch_items", {
          party_id: id, file_id: Number(i.file_id), name: String(i.name), url: String(i.url), mime: String(i.mime ?? ""), size: Number(i.size ?? 0), position,
        }));
        data.insert("watch_guests", { party_id: id, user_id: r.userId });
        return { id };
      });

    onApi("set-message", "Records the chat message that announced a party (its host only); returns { updated }.",
      [
        { name: "party_id", type: "bigint", description: "The party." },
        { name: "message_id", type: "bigint", description: "The announcing message." },
      ],
      (r) => {
        const row = party(r.args.party_id);
        if (row.host_id !== r.userId) throw new InvalidRequest("Only the host announces the party.");
        return { updated: data.update("watch_parties", { message_id: r.args.message_id }, { id: row.id }) };
      });

    onApi("get-party", "One party with its playlist and guests: { party }.",
      [{ name: "party_id", type: "bigint", description: "The party." }],
      (r) => ({ party: details(party(r.args.party_id)) }));

    onApi("list-parties", "A voice channel's parties that haven't ended, with playlists and guests: { rows }.",
      [{ name: "channel_id", type: "bigint", description: "The voice channel." }],
      (r) => ({ rows: data.select("watch_parties", { channel_id: r.args.channel_id }).filter((p) => p.ended !== true).map(details) }));

    onApi("join-party", "Joins a party (it then counts on you having the videos), or leaves it with joined: false; returns { changed }.",
      [
        { name: "party_id", type: "bigint", description: "The party." },
        { name: "joined", type: "bool", required: false, description: "false to leave." },
      ],
      (r) => {
        const row = party(r.args.party_id);
        const mine = data.select("watch_guests", { party_id: row.id, user_id: r.userId }).length > 0;
        if (r.args.joined === false) return { changed: mine && data.delete("watch_guests", { party_id: row.id, user_id: r.userId }) > 0 };
        if (mine) return { changed: false };
        if (row.ended === true) throw new InvalidRequest("That watch party has ended.");
        data.insert("watch_guests", { party_id: row.id, user_id: r.userId });
        return { changed: true };
      });

    onApi("set-playback", "Plays, pauses, seeks or changes the video of a party, for everyone; returns { updated }.",
      [
        { name: "party_id", type: "bigint", description: "The party." },
        { name: "item", type: "int", description: "The playlist entry, from 0." },
        { name: "playing", type: "bool", description: "Playing or paused." },
        { name: "position", type: "decimal", description: "Seconds into the video." },
      ],
      (r) => {
        const row = party(r.args.party_id);
        if (row.ended === true) throw new InvalidRequest("That watch party has ended.");
        const item = Number(r.args.item);
        if (!Number.isInteger(item) || item < 0 || item >= items(row.id).length) throw new InvalidRequest("No such video in the playlist.");
        const position = Math.max(0, Number(r.args.position) || 0);
        return {
          updated: data.update("watch_parties", {
            item, playing: r.args.playing === true, position, changed_at: new Date().toISOString(), changed_by: r.userId,
          }, { id: row.id }),
        };
      });

    onApi("start-now", "Starts a party that hasn't started yet now instead of at its time (its host, or a member who may manage messages); returns { updated }.",
      [{ name: "party_id", type: "bigint", description: "The party." }],
      (r) => {
        const row = party(r.args.party_id);
        if (row.ended === true) throw new InvalidRequest("That watch party has ended.");
        const now = new Date();
        if (Date.parse(String(row.starts_at)) <= now.getTime()) return { updated: 0 };
        return { updated: data.update("watch_parties", { starts_at: now.toISOString() }, { id: row.id }) };
      });

    onApi("end-party", "Ends a party (its host, or a member who may manage messages); returns { updated }.",
      [{ name: "party_id", type: "bigint", description: "The party." }],
      (r) => {
        const row = party(r.args.party_id);
        if (row.ended === true) return { updated: 0 };
        return { updated: data.update("watch_parties", { ended: true, playing: false, changed_at: new Date().toISOString(), changed_by: r.userId }, { id: row.id }) };
      });

    onApiRead((r) => data.select(r.table, r.where));
  },
};
