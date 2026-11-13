// A workspace's own emoji. The image is content (a mwc: ref) and a small preview travels
// with the row, so the picker can show it before the content arrives. Removing one only hides it: old messages and
// reactions still render, and its name stays reserved.
import type { MockPlugin } from "./backend";
import { InvalidRequest } from "./errors";
import { emojiNameProblem } from "../markdown/emoji";

export const emojiMimes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const maxEmojiBytes = 512 * 1024;

const contentRef = /^mwc:[0-9a-f]{64}$/;
const preview = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

// The row rules shared by the plugin and every member's policy check.
export function emojiRowProblem(row: Record<string, unknown>): string | null {
  if (!contentRef.test(String(row.url ?? ""))) return "The emoji image must be content (mwc:...).";
  if (!emojiMimes.includes(String(row.mime ?? ""))) return "Emoji images must be PNG, JPEG, WebP or GIF.";
  const size = Number(row.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxEmojiBytes) return "Emoji images can be at most 512 KB.";
  const width = Number(row.width);
  const height = Number(row.height);
  if (!Number.isSafeInteger(width) || width < 1 || width > 100_000) return "The image width is not valid.";
  if (!Number.isSafeInteger(height) || height < 1 || height > 100_000) return "The image height is not valid.";
  if (typeof row.thumb !== "string" || row.thumb.length > 100_000 || !preview.test(row.thumb))
    return "The emoji needs a small image preview.";
  return null;
}

export const emoji: MockPlugin = {
  manifest: {
    name: "emoji",
    version: "1.0.0",
    description: "A workspace's own emoji, uploaded as images and usable in messages and reactions.",
    tables: [
      {
        name: "emoji_emojis", parent: null,
        columns: {
          name: "text", url: "text", thumb: "text", mime: "text", size: "bigint", width: "int", height: "int",
          author_id: "bigint", created_at: "timestamp", deleted: "bool",
        },
      },
    ],
  },

  register({ data, onApi, onApiRead }) {
    const name = (value: unknown) => {
      const text = String(value ?? "");
      const problem = emojiNameProblem(text);
      if (problem) throw new InvalidRequest(problem);
      return text;
    };
    const row = (id: unknown) => {
      const [found] = data.select("emoji_emojis", { id: id as number });
      if (!found) throw new InvalidRequest(`Unknown emoji ${id}`);
      return found;
    };

    onApi("add-emoji", "Adds a custom emoji to the workspace; returns its id.",
      [
        { name: "name", type: "text", description: "Shortcode name: 2-32 a-z, 0-9 or _." },
        { name: "url", type: "text", description: "The image content (mwc:...)." },
        { name: "thumb", type: "text", description: "A small preview (data URL) shown while the content arrives." },
        { name: "mime", type: "text", description: "Image media type." },
        { name: "size", type: "bigint", description: "Image size in bytes." },
        { name: "width", type: "int", description: "Image width in px." },
        { name: "height", type: "int", description: "Image height in px." },
      ],
      (r) => {
        const code = name(r.args.name);
        if (data.select("emoji_emojis").some((existing) => existing.name === code))
          throw new InvalidRequest(`An emoji named :${code}: already exists, or its name is still reserved.`);
        const problem = emojiRowProblem(r.args);
        if (problem) throw new InvalidRequest(problem);
        const id = data.insert("emoji_emojis", {
          name: code, url: r.args.url, thumb: r.args.thumb, mime: r.args.mime, size: r.args.size,
          width: r.args.width, height: r.args.height, author_id: r.userId, created_at: new Date().toISOString(), deleted: false,
        });
        return { id };
      });

    onApi("remove-emoji", "Hides a custom emoji from the picker and new messages, keeping old rows working; returns { removed }.",
      [{ name: "id", type: "bigint", description: "The emoji." }],
      (r) => {
        const found = row(r.args.id);
        if (found.deleted === true) throw new InvalidRequest(`Emoji ${r.args.id} was already removed.`);
        data.update("emoji_emojis", { deleted: true }, { id: found.id });
        return { removed: true };
      });

    onApiRead((r) => data.select(r.table, r.where));
  },
};
