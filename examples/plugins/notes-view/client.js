// Example MakeWork plugin with a declared data side: a view for "notes" channels. Each note is a row in the
// workspace's "example_notes_view_notes" table (see manifest.json), stored and synced by a generic server plugin. Install it
// from Settings > Plugins > Install from file, then add a Notes channel and say yes to "Add plugin X to this
// workspace?". Plain DOM, no framework or build step.

function notesView(element, context) {
  element.innerHTML = `
    <style>
      .notes { padding: 24px; max-width: 640px; }
      .notes h2 { color: var(--mw-accent); font-weight: 500; margin: 0 0 4px; }
      .notes p { color: var(--mw-text-disabled); margin: 0 0 16px; }
      .notes form { display: flex; gap: 8px; margin-bottom: 16px; }
      .notes input { flex: 1; font: inherit; color: inherit; background: var(--mw-darker); border: none;
        padding: 6px 10px; border-radius: var(--mw-corner); }
      .notes button { font: inherit; color: var(--mw-accent-text); background: var(--mw-accent); border: none;
        padding: 6px 14px; border-radius: var(--mw-corner); cursor: pointer; }
      .notes li { list-style: none; background: var(--mw-dark); padding: 8px 12px; margin-bottom: 6px;
        border-radius: var(--mw-corner); }
      .notes .who { color: var(--mw-link); font-size: 12px; margin-top: 2px; }
      .notes ul { padding: 0; }
      .notes .error { color: var(--mw-warning); }
    </style>
    <div class="notes">
      <h2></h2>
      <p>Every note is a row in the workspace, synced to everyone with the plugin installed.</p>
      <form><input placeholder="Write a note" required><button>Add</button></form>
      <div class="error"></div>
      <ul></ul>
    </div>`;

  const title = element.querySelector("h2");
  const list = element.querySelector("ul");
  const form = element.querySelector("form");
  const input = element.querySelector("input");
  const error = element.querySelector(".error");
  title.textContent = context.channel.name;

  async function refresh() {
    const rows = await context.api.read("example_notes_view_notes", { channel_id: context.channel.id });
    list.replaceChildren(...rows.map((note) => {
      const item = document.createElement("li");
      item.textContent = note.note;
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = context.users.get(note.author_id).displayName;
      item.append(who);
      return item;
    }));
  }

  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      await context.api.insert("example_notes_view_notes", { note: input.value, channel_id: context.channel.id });
      input.value = "";
      error.textContent = "";
    } catch (e) {
      error.textContent = e.message;
    }
  };

  const stop = context.api.onEvent(() => void refresh());
  void refresh();
  return stop;
}

export default {
  manifest: {
    id: "example.notes-view",
    name: "Notes view",
    version: "1.0.1",
    description: "A simple view for notes channels that keeps every note as a row in the workspace.",
    author: "MakeWork examples",
    contributes: {
      channelTypes: [{ id: "notes", label: "Notes", icon: "file" }],
    },
  },
  channelViews: { notes: notesView },
};