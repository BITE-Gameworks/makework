// Mirrors Extensions/Example: short notes that can be tagged.
import type { MockPlugin } from "../../system/backend";
import { InvalidRequest } from "../../system/errors";

export const example: MockPlugin = {
  manifest: {
    name: "example",
    version: "1.0.0",
    description: "Short notes that can be tagged.",
    tables: [
      { name: "example_notes", parent: null, columns: { note: "text", created_at: "timestamp" } },
      { name: "example_note_tags", parent: "example_notes", columns: { note_id: "bigint", tag: "text" } },
    ],
  },

  register({ data, onApi, onApiRead, onApiInsert, onApiUpdate }) {
    onApi("add-note", "Adds a note, stamped with the current time; returns its id.",
      [{ name: "note", type: "text", description: "The note text." }],
      (r) => ({ id: data.insert("example_notes", { note: r.args.note, created_at: new Date().toISOString() }) }));

    onApi("tag-note", "Tags an existing note; returns the tag's id.",
      [
        { name: "note_id", type: "bigint", description: "The id of the note." },
        { name: "tag", type: "text", description: "The tag to add." },
      ],
      (r) => {
        if (data.select("example_notes", { id: r.args.note_id }).length === 0)
          throw new InvalidRequest(`Unknown note ${r.args.note_id}`);
        return { id: data.insert("example_note_tags", { note_id: r.args.note_id, tag: r.args.tag }) };
      });

    onApi("list-notes", "Lists every note with its tags.", [], () => {
      const tags = data.select("example_note_tags");
      return {
        rows: data.select("example_notes").map((note) => ({
          ...note,
          tags: tags.filter((t) => t.note_id === note.id).map((t) => t.tag),
        })),
      };
    });

    onApiRead((r) => data.select(r.table, r.where));
    onApiInsert((r) => data.insert(r.table, r.values));
    onApiUpdate((r) => data.update(r.table, r.values, r.where));
  },
};
