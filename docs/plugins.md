# Writing MakeWork plugins

There are two kinds of frontend plugin.

| Kind | Where it comes from | Runs | Access |
|------|---------------------|------|--------|
| **Client plugin** | A `.mwp` package the user installs (Settings > Plugins) | In the app | Full, like any program you install |
| **Workspace UI** | A workspace plugin's `client-ui` function | In a sandboxed iframe | Only its own plugin on its own workspace |

A workspace plugin doesn't need either: any plugin without a UI is shown with a generic view built
from `describe` (its tables, an add-row form, and a form for each function).

For a channel, the app uses the first that exists: a client plugin view for the channel's type, the
workspace's `client-ui`, the generic view.

## Client plugins

An `.mwp` is a zip package containing `manifest.json`, the client module (by default `client.js`), and optional
`icon.svg` and `assets/` files. It is kept on this device in IndexedDB. The authoring example is in
`examples/plugins/notes-view/`; from `app/`, run `npm run pack-plugins` to generate its `.mwp` package.

`manifest.json` is the source of truth for plugin identity and data. The `client.js` module's default export supplies
the views and other client code; its `manifest` must have the same id and version, and package metadata fills its
manifest fields. The package's optional `minApp` prevents installation in older MakeWork versions.

```js
// client.js
export default {
  manifest: {
    id: "example.notes-view",        // a-z, 0-9, '.', '-'; must match manifest.json
    name: "Notes view",
    version: "1.0.0",
    contributes: {
      channelTypes: [{ id: "example", label: "Notes", icon: "file" }],
    },
  },
  channelViews: {
    example(element, context) {
      element.textContent = `Hello ${context.user.displayName}`;
      return () => { /* cleanup on unmount */ };
    },
  },
};
```

- **Package manifest:** `manifest.json` has `id`, `name`, `version`, optional `description`, `author`, `minApp`,
  `icon` (an SVG path in the package, drawn in the theme's text color: only its shape counts), `client` (the module path, default `client.js`), and optional `data`. Data tables are declarative; the app replays
  them without executing plugin code:

  ```json
  {
    "id": "example.notes-view",
    "name": "Notes view",
    "version": "1.0.0",
    "data": {
      "type": "example",
      "tables": {
        "example_notes_view_notes": {
          "columns": { "note": "text", "author_id": "user" },
          "channel": true,
          "authored": "author_id"
        }
      }
    }
  }
  ```

  Table names start with the plugin id normalized to lowercase letters, digits and underscores (`.` and `-` become
  `_`), followed by `_`. A table's columns use `text`, `integer`, `real`, `bool`, `json` or `user`; `json` values are
  JSON-serialized strings because the API accepts scalar values. Set `channel: true`
  for rows belonging to a channel; MakeWork adds `channel_id` if it is not listed. `authored` names a column set to
  the inserting member and fixed after insertion. `owned: true` makes rows changeable only by their creator or a
  member with Manage messages. Tables without `channel: true` are workspace-wide and only the workspace owner may
  change them. `data.type` selects the channel type and API plugin name for these tables; by default it is the first
  contributed channel type.

  When a plugin is added to a workspace, its resolved data manifest and package reference become part of that
  workspace's signed history. The registration is permanent (even after its last channel is deleted), so every
  member can replay the plugin's older table changes. Removing the installed client plugin only affects this device.

- **Installing and trust:** Settings > Plugins accepts `.mwp` files only, or a package can be dropped on the page.
  Installed plugins have an **Update from file** action; the replacement must have the same plugin id and a newer
  numeric version. Installing or updating runs the module inside MakeWork with full access to the signed-in user's
  data. Only install packages from authors you trust. A workspace can offer its stored package to members who do
  not have it; MakeWork asks before installing and identifies the author.
- **Workspace settings:** Settings > Plugins lists the workspace's registered data plugins and indicates whether
  each client plugin is installed on this device. Members with Manage workspace can add an installed plugin's data
  schema. That registration and package reference are immutable in signed history, so updating a local `.mwp` does
  not change the schema already registered in a workspace.
- **Channel types:** `id` is the name of the workspace plugin behind the channel. `icon` is an icon name
  (`app/src/theme/icons.tsx`) or a `data:image/svg+xml` URL. A later plugin replaces an earlier one's type.
  `keepAlive` controls that: omitted keeps the view as it was until the window's kept-view bound lets it go, a
  number (seconds) keeps it that long after the user was last in the channel (the browser uses 600), and `false`
  mounts it fresh on every visit. `ownWindow: false` keeps the type's tabs in the main window: the view can't be
  popped out into a view window (voice uses this, since calls and their media stay in the main window).
- **Channel views** get an empty element and a context:

  | Field | |
  |-------|--|
  | `workspace` | `{ id, name }` |
  | `server` | `{ id, name }` (deprecated alias for `workspace`) |
  | `channel` | `{ id, name, type, category }` |
  | `user` | `{ username, displayName }` |
  | `users` | Profiles on the workspace: `me()` (your id), `get(id)`, `list()`, each `{ id, username, displayName, color }`, and `assignable()`: who work can be given to (people, and bots set to be assignable). |
  | `api` | Client pinned to the channel's plugin: `call(action, args)`, `read(table, where)`, `insert(table, values)`, `update(table, values, where)`, `delete(table, where)`, `describe()`, `onEvent(handler)` (returns an unsubscribe function). Errors carry `code` from API.md. |
  | `asset(path)` | Reads a file from this plugin package (for example `"assets/logo.svg"`) as a data URL, or returns null if it is unavailable. |
  | `openSidePanel(title, mount)` | Opens the side panel; `mount(element)` works like a view and may return a cleanup. |
  | `closeSidePanel()` | |
  | `openFile(file)` | Opens a file in the best viewer. |
  | `target()` | The object a followed link points at, `{ kind, id }`, or null. A new object each time a link is followed, so watch it and scroll to or open that object. |
  | `linkTo(target?)` | A `makework://` link to this channel, or to `{ kind, id }` in it. |
  | `openLink(url)` | Follows a `makework://` link. |
  | `openContextMenu(event, entries)` | A right-click menu: entries `{ label, icon?, action, disabled?, danger? }` or `"separator"`. |
| `openUserMenu(event, userId)` | The app's right-click menu for a member (profile, copy name, ...). |
| `toggleSidePanel(key, title, mount)` | For buttons that open a side panel: opens it, or closes it when the panel named `key` is already open. `openSidePanel(title, mount, key?)` only opens; `isSidePanelOpen(key)` is reactive, for showing the button as active. A channel's panels close when the user leaves it. |
| `active()` | Whether the view is shown (reactive). False while a channel type with `keepAlive` keeps it open, hidden, after the user left; presence and cursor are held back meanwhile. |
| `presence` | Live state shared with the other members who have the channel open, never stored: `set(object or null)` sends yours (rate-limited), `others()` gives `{ userId, state }[]` (reactive). The key `cursor` is reserved. |
| `cursors` | Virtual cursors, in your view's own coordinates (board or page units): `move({ x, y } or null)` on every pointer move, `others()` gives `{ userId, x, y }[]` (reactive), `draw(element, toScreen)` draws them in each member's color with their name and returns `{ redraw, remove }` (call `redraw()` after panning or zooming). Anything that joins the channel moves a cursor the same way (`cursor: { x, y }` in its presence), so later bots will show up in your view without changes. |
| `events` | Short messages to the other members who have the channel open, sent at once and never stored: `send(json)`, `listen((userId, json) => ...)` returns a function that stops listening. Each member's messages arrive in order. The shared browser sends its clicks and keys this way. |
| `can(permission)` | Whether the signed-in user has a workspace permission (`send_messages`, `edit_content`, `manage_messages`, `manage_channels`, ...; reactive). Changes without it are refused, so hide or disable those controls. |
| `playSound(name)` | Plays one of the theme's sounds: `mention`, `join`, `leave`, `peer-join`, `peer-leave`, `mute`, `unmute`, `deafen`, `undeafen`, `stream-start`, `stream-stop`, `disconnect`, `task-done`, `upload-done`, `error`. |
  | `history` | Undo/redo for this channel, kept for the session: after doing something, `push({ label, icon?, undo, redo })` where `undo` and `redo` return promises. Also `undo()`, `redo()`, `goTo(n)`, `entries()`, `position()`, `canUndo()`, `canRedo()`. Built-in views show it with undo/redo buttons, a step list and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. |

- **Links:** anything can link to anything with `makework://<workspace>/<channel>[/<kind>/<id>]`, written in markdown as
  `[title](makework://...)`; text shows them as chips with the object's current name. The editor's `#` picker and
  link chips ask the plugin of the channel's type through `links`:

  ```js
  links: {
    example: {   // channel type
      async resolve({ kind, id }, context) { return { title: "Buy milk", icon: "file" }; },   // or null if gone
      async search(query, context) { return [{ kind: "note", id: 1, title: "Buy milk" }]; },  // query is lowercase
    },
  },
  ```

  `context` has `workspace` (`server` remains a deprecated alias), `channel`, `user`, `users` and `api` like a view's. When a link opens the channel, the view
  gets the object in `context.target()`.

- **Live exports:** a plugin can make selected content available in other channels with `exports`, keyed by channel
  type. Export links use `makework://<workspace>/<channel>/export/<id>`; in Markdown, image syntax mounts the live
  preview while a plain link remains a link chip. Export rendering receives the reader's channel context and API
  permissions. Providers update their mounted element when source data changes and return cleanup when unmounted:

  ```js
  exports: {
    example: {
      async list(context) {
        return [{ id: "summary", name: "Summary", kinds: ["image", "svg"] }];
      },
      render(id, kind, context, element) {
        const update = async () => {
          const rows = await context.api.read("example_rows");
          element.textContent = `${rows.length} rows`;
        };
        void update();
        const off = context.api.onEvent(() => void update());
        return off;
      },
      async file(id, format, context) {
        return { name: "summary.svg", blob: new Blob(["<svg/>"], { type: "image/svg+xml" }) };
      },
    },
  },
  ```

  `list` returns `{ id, name, kinds }` entries (`image`, `svg`, `table` or `text`). `render` mounts the requested
  representation into an element; embeds are only mounted while visible. The link picker includes matching exports.
  `file` is optional and lets disk layouts or download actions materialize a selected format.

- **File viewers:** declare them under `contributes.viewers` and implement them under `viewers` with the same id.
  The best match by `mimeTypes` (`"image/*"` wildcards work) or `extensions` opens the file; later plugins win, and
  the user can switch with "Open with". A viewer gets an element and the file:

  ```js
  contributes: { viewers: [{ id: "csv", label: "Table", mimeTypes: ["text/csv"], extensions: ["csv"] }] },
  viewers: {
    async csv(element, file) {          // file: { name, mimeType, size, read() -> Promise<Blob> }
      const text = await (await file.read()).text();
      element.textContent = `${text.split("\n").length} rows`;
    },
  },
  ```

  Channel views open files with `context.openFile(file)`.
- **Styling:** use the theme variables so the view follows the user's theme: `--mw-accent`,
  `--mw-accent-text`, `--mw-text`, `--mw-text-muted`, `--mw-text-disabled`, `--mw-border`, `--mw-link`,
  `--mw-warning`, `--mw-success`, `--mw-light`, `--mw-dark`, `--mw-darker`, `--mw-font-ui`, `--mw-font-code`,
  `--mw-font-size`, `--mw-corner`, `--mw-border-width`, `--mw-gap`, `--mw-duration`.
- Built-in and installed plugins are listed separately in Settings > Plugins. Either kind can be disabled; installed
  plugins can also be removed from this device.
- **Settings:** a plugin lists its settings in `settings` (types `heading`, `text`, `secret`, `toggle`, `number`,
  `select`, `suggest`: a text field whose suggestions the plugin fetches, e.g. a server's models, and `custom`: a
  `render()` of the plugin's own, e.g. a list of downloads). Settings > Plugins shows them under a "Settings" arrow
  at the bottom of the plugin's card. Values are kept on this device; views read them
  with `context.setting(key)` (reactive, the declared `default` when unset) and secrets with `context.secret(key)`
  (system keychain on desktop). `when` hides a setting that doesn't apply, `desktop: true` shows it only in the app.
  What a whole workspace shares goes in `workspaceSettings`, a component drawn in Workspace settings > Plugins, which
  syncs its own values.

  ```js
  settings: [
    { type: "toggle", key: "sounds", label: "Play sounds", default: true },
    { type: "text", key: "server", label: "Server address", placeholder: "http://localhost:8080", when: (v) => v("sounds") === true },
  ],
  ```

### Ping-pong example

`examples/plugins/pingpong/` is a small runnable game showing how an installed plugin combines a declared table
with live channel state. From `app/`, run `npm run pack-plugins`, install `examples/plugins/pingpong.mwp` from
Settings > Plugins, then add Ping-pong to a workspace and create a Ping-pong channel. Install the package in each
client that should render the game; add it to the workspace when prompted so the declared table is available to
everyone.

The example keeps scores, the running state, and last paddle holders in its declared `example_pingpong_games` table.
Paddle claims use presence, so they disappear when a player leaves; positions remain after release until Stop resets
them. Grab an actual paddle to drag it; the cursor keeps its original offset from the point grabbed. Claims are sorted
by grab time and then user id, matching the design editor's deterministic holder rule.
The member who starts the game simulates
the ball and sends snapshots with `events`; if that member leaves, the lowest user id among members with the channel
open takes over. No game frame is written to the signed data log. Try it with two clients in the same channel to see
the paddles, live ball, scores, and handoff in action.

## Workspace UI (`client-ui`)

A workspace plugin registers a function named `client-ui` that returns `{ "html": "<...>" }`. The app
puts the HTML in an iframe with `sandbox="allow-scripts"` (opaque origin: no access to the app, its
storage, cookies or other workspaces) and a CSP that blocks all network access. Inline scripts and styles,
`data:` and `blob:` images work. The theme variables above are set on the frame's `<html>` and kept up to date.

The page talks to its plugin through `window.makework`, injected before your HTML:

```js
await makework.ready;                     // resolves with the context { workspace, server, channel, user }
const { rows } = await makework.request({ action: "read", table: "poll_options" });   // your plugin's table
await makework.request({ action: "vote", args: { option_id: 1 } });                  // and its functions
makework.onEvent((event) => refresh());   // change events of this plugin
```

`request` takes the API.md request fields except `plugin`, which is always the channel's own plugin.
It resolves with `data` or rejects with an `Error` that has `code`.

No mock plugin uses `client-ui` at the moment; `app/src/plugins/SandboxFrame.tsx` is the host side.

## Bot plugins

A client plugin may contribute bot types with `bots`. A bot is a workspace member with a generated user id and a
workspace record in `bots_bots`. It runs on its host member's devices (the creator, or whoever chose "Run on my
devices" in Workspace settings > Bots); when that account is open on several devices, they agree over the mesh and
the first to start the bot keeps it. Nothing about running is stored. The host signs what the bot writes, and the
policy checks it against the bot's own roles (a bot can't post where it lacks Send messages).

`start` runs again whenever the bot restarts (an app start, a settings change, another device taking over), so don't
post on start: look at the channel first (the Announcer example waits out its interval since its last post).
`context.log` lines stay on the running device and show in the Bots tab there.

```js
export default {
  manifest: { id: "example.reply", name: "Reply bot", version: "1.0.0" },
  bots: {
    reply: {
      label: "Reply",
      settings: { channel: { label: "Channel id", type: "number" } },
      async start(context) {
        await context.log("started");
      },
    },
  },
};
```

Bot types can declare `permissions` (`read:<plugin>`, `memory`, `presence`), `commands` and settings of type
`channel` / `channels` (empty list = any channel). An admin approves the permissions when adding the bot (stored as
`_permissions` in its settings, changeable in the Bots tab); `context.read`, `context.onEvent`, `context.memory` and
`context.online` throw without them. Commands run after `@bot /name args`; a bare mention answers with the commands
as buttons (a click posts the command as the clicking member). Memory is a key/value store per bot (64 KB, synced,
shown and clearable in the Bots tab). The built-in Taskbot, Helpbot, Gitbot and Automoderator live in
`app/src/plugins/builtin/bots/`.

`BotContext` exposes the bot record and JSON settings, the signed plugin API, channel/message lookup, `send`,
`openChannel`, `openLink`, and `log` (kept on the running device). A bot handle is its type plus a per-type number, such as
`@replybot#1`; the bot's chosen (or generated) nickname is displayed after it, with a MakeWork badge. `fuzz` is
optional and is used by Tester-style bots to run a plugin's own deterministic checks. Bots should stop timers and
subscriptions from the cleanup function returned by `start`. The `examples/plugins/bots/` package contributes the
`Reply`, `Announcer`, and `Tester` types; it is not installed by default. From the repository root, run
`node app/scripts/pack-plugin.mjs examples/plugins/bots examples/plugins/bots.mwp`, then install that package in
Settings > Plugins before creating bots of those types.
