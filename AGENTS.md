# Working on MakeWork

Instructions for anyone changing this repository, people and coding agents alike. What the app is and how it works is in
`docs/` (start with `docs/README.md`); read the part for the area you touch before changing it.

## Working alongside others

Other people and agents may be working in the same checkout at the same time. Either:

- **ignore their work**: don't revert, reformat, "fix" or commit changes you didn't make, and don't chase failures
  outside what you were asked to do; or
- **coordinate through `NOTES.md`** at the repository root when your work touches theirs (the same files, a shared
  interface, a migration, a release). Add a timestamped entry and read the entries above it:

  ```
  ## 2026-11-13 14:05 (your name or agent)
  Changing `UserServerError` to carry `needs` instead of `needsCode`; callers in core/account.ts updated.
  ```

  Remove your entries once they no longer matter. `NOTES.md` is for coordination, not a work log: history belongs in
  commit messages.

## Before and after a change

- Run in `app/`: `npm run typecheck`, `npm run lint`, and `npm test` (or the tests for the area). For builds, CSP and
  packaging changes also `npm run build:web`. Commands and setup: `docs/development.md`.
- Keep checks light for visual work: make sure it builds and renders, then leave the look to a person.
- Commit messages say what changed and why. Don't add generated files, local settings or build output.
- When a decision with real alternatives is made, add a section to `docs/decisions.md`. When behavior described in
  `docs/` changes, change the doc in the same commit.

## Code style

- Prefer code that explains itself: clear names, small functions, named constants.
- Comment only what the code can't say: the reason for a non-obvious choice, a unit, an API quirk, an ordering
  requirement. Keep comments short, plain, sentence case, present tense.
- No comments that describe the bug that led to a fix or continue a conversation ("now fixed", "as requested",
  "changed this to"). A comment must make sense to someone who never saw the bug; a gotcha anyone could hit again is
  written as a general rule.
- No commented-out code, change logs, dates or commit hashes in comments. That is what version control is for.
- No emojis, em dashes or en dashes in comments.
- Match the existing style of the file.
- Tests live in `app/tests/`, mirroring `src/`, never next to the code.

## Rules

- The client talks to a workspace's data only through `ApiClient` -> `Transport`. No UI code builds raw requests.
- Serverless data changes only through the ledger; never write tables around it. Every change must pass `p2p/policy.ts`
  on every member, so a new kind of change needs a rule there (or it is open to all members). Policy rules read the
  commit's time, never the clock (decision 0008).
- A change older apps would refuse raises the log version (`p2p/log.ts`).
- Say "plugin", never "extension" (so nobody thinks of browser extensions). "extension" in file names is unrelated.
- Say "workspace" for the collaboration space in code and text (`workspaceId`, `WorkspaceBar`). `ChannelContext.server`
  stays as a deprecated alias for installed plugins. "Server" is for real services: the user server, TURN, web servers.
- Plugins take the acting user from `r.userId`, never a constant.
- New features a plugin could provide are built as built-in plugins through the registry. A plugin's options belong to
  it (`ClientPlugin.settings`, `workspaceSettings`); shell and core never read a plugin's settings, and plugins don't
  read each other's. Shared needs go in shared code with no settings of its own (`core/llm.ts`).
- Skills for a kind of channel belong to its plugin (`plugins/builtin/<type>/agentSkills.ts`); agents never name a
  plugin's tables.
- Encrypted chat (decision 0021): new chat writes need their channel key, so they go through the workspace's API
  (`KeyedTransport`, `p2p/chatKeyring.ts`).
- Never put file content into workspace data: store it with `prepareUpload` (or `core/stream.ts`) and save the `mwc:`
  ref. Render it with `contentUrl(url)` (null while it is a ghost; show `thumb` then).
- API values are scalars only; lists (tags, reactions, attachments) need child tables.
- Local plugin tables (`voice`, `localPlugins` in `p2p/plugins.ts`) exist only on the device that runs the plugin, never
  in the ledger: node code must decide from the ledger.
- Synced row ids are time-ordered random numbers below 2^53, not 1, 2, 3, and a new row's id can change once if two
  devices drew the same one: never keep a new row's id elsewhere before its commit settled.
- Emoji: encode with `encodeEmoji` before sending user text, render with `splitEmoji` or `Markdown`.
- Synced values in markup strings for `innerHTML` must be escaped (`attributeText` in `design/model.ts`, `esc` in
  `diagram/render.ts`): the page can reach terminals and tokens. The plugin sandbox iframe keeps its CSP at no network.
- Trystero's core is a patched copy (`app/vendor/trystero-core`): read its README before upgrading `trystero`.
- Big workspaces have tens of thousands of commits and files: anything that runs per file must not scan all rows each
  time (build a Set or Map once per pass; `groupRows` in `system/data.ts`), and per-item reactive state is keyed per item
  (a store, not one signal holding a Set).
- Lists fed by refetches keep object identity (`reconcile(..., { key: "id" })`). Those objects change in place, so copy
  any value an undo step or later callback needs. Defaults put into a store are built fresh each time.
- Solid's `<Show when>{(x) => ...}` runs its callback once: a ternary inside never switches; use `<Switch>`/`<Match>`.
  A computation that throws during an update drops every effect queued after it: render views keyed by derived state
  under `<Show when={data}>`.
- Moving an element in the DOM resets the scroll positions inside it: keep views in place (`keptInPlace()`).
- Desktop and platform specifics: `docs/desktop.md`. Read it before touching `electron/` or disk paths.

## UI conventions

- Style only with theme variables (`var(--mw-accent)` etc.), never hard-coded colors, bar sizes, fonts or radii.
- Space views with the theme's margin: `var(--mw-margin)` at a view's edges, `calc(var(--mw-margin) / 2)` inside boxes.
  Never literal pixel gutters.
- Animate every appearing, disappearing or changing element; no jumps. Use `var(--mw-duration)` and `var(--mw-ease)`
  (0 with reduced motion), `Collapse` for height, `createPresence` for exits, `mw-fade-in` for new content.
- Animate only `transform` and `opacity` for anything that runs often. Layout properties are for one-off changes. Use
  FLIP when an element changes place. Indicators that change many times a second change without a transition.
- No endless animation should keep running: one keeps the window drawing every frame. Anything that waits without end
  turns smoothly only at first, then in steps (`.mw-spinner`). Never an endless CSS animation inside an SVG. Canvas loops
  run on a timer (never a requestAnimationFrame every frame), redraw only what changed, and stop while unseen.
- Power saving: decorations that keep redrawing stop or slow under `:root[data-power="saving"]` or `powerSaving()`.
- Narrow layouts (below 760 px wide or 500 px tall, `narrow` in `core/ui.ts`) show one pane. View headers wrap at every
  width: check 800 to 1000 px too.
- Elements with a themed shape get `class="mw-box"`. Icons via `<Icon name="..."/>`; new names go into `icons.tsx` and
  the Sharp and Phosphor packs.
- Online dots are `var(--mw-success)`, never the accent.

## Consistency

Every similar thing behaves the same and its code exists once. Before adding UI, reuse:

- Long lists: `ui/progressive.ts` `createProgressive`; message lists through `messaging/messageWindow.ts`. Never one
  `<For>` over a list that can grow to thousands. A view's first data comes after its slide in (`afterSlides`).
- Messages and the message box: `messaging/MessageCard` and `messaging/MessageComposer`, for chat and private messages.
- Searching across the app: `shell/QuickSwitcher`. New shortcuts go in `shell/shortcuts.ts`.
- A caught failure that shouldn't happen: `reportCrash` (`core/crashReports.ts`); nothing is sent without the person
  pressing Send.
- Feedback on what the user just did: `showToast` (`core/notices.ts`). `showNotice` is for things that need an answer.
- Copying text: `copyText` (`core/clipboard.ts`), `copyToClipboard` and `createCopied` (`ui/clipboard.ts`). Never
  `navigator.clipboard.writeText` elsewhere.
- Undo and redo in a view's header: `<div class="view-tools view-history mw-box">`.
- Scrolling areas get `mw-scroll-fade`, except text being edited.
- Pages over the workspace (Settings, Workspace settings, profile): the `overlay` state in `core/ui.ts`, shown by
  `shell/Overlays.tsx` in `ui/OverlayPage`; buttons are `ui/OverlayButton`.
- Any button that opens something closes it on a second click and shows as active while open. Side panels:
  `toggleSidePanel` or, in plugins, `context.toggleSidePanel`.
- Other members' pointers: `context.cursors` and `ui/RemoteCursors`. A caller's name: `voice/SpeakerName`.
- Resizable panels: `ui/ResizeHandle`. Disclosures: `ui/Disclosure` with `Collapse`.
- A plugin's options: `ClientPlugin.settings` (shown by `plugins/PluginSettingsForm`), never a settings page of its own.
- Dropdowns: `ui/Select`; text fields with suggestions: `ui/Combobox`. Never a native `<select>` or `<datalist>`.
- Right-click choices from a list: one submenu entry (`{ label, icon, items }`, `ui/contextMenu.ts`).
- Picking a member: `ui/MemberSearch` with `matchMembers`. Never a dropdown of every member.
- Canvas exports: `canvas/export.ts` and `canvas/ExportSettings.tsx`; zoom: `canvas/ZoomBar`; touch: `canvas/touch.ts`;
  selection frames: `canvas/SelectionHandles`; SVG text: `canvas/text.ts` `wrapText`.
- Colors: `ui/ColorSwatches`. A channel named in a list: `channelLabel` (`core/workspaces.ts`).
- Files dragged in: `createFileDrop` and `DropHint` (`ui/FileDrop.tsx`).
- Side panels describing one thing: `ui/InfoPanel`. Show what matters to the user, never raw ids.
- Something on its way: `.mw-spinner`. Loading inside a view: `ui/Skeleton` in the view's shape; startup: `shell/LoadingView`.
- A field that takes the keyboard when shown: `ref={focusWhenShown}` (`ui/focus.ts`), never `autofocus`.
- New-password fields: `shell/PasswordRule` and "The passwords don't match." under the confirm field.
- A plugin's icon: `plugins/PluginIcon`.
- Short forms over the app: `ui/Dialog`. A layer that closes on Escape checks `!e.defaultPrevented && !dialogOpen()`.
- Destructive confirms: `ui/ConfirmPrompt` (`ConfirmItem` in menus); inline rename in menus: `RenameItem`.
- Trimming characters off text: `trimEnd`, `trimStart`, `trimChars` (`core/text.ts`), never a pattern like `/x+$/`.
  Sorting text: `compareText`, never a bare `.sort()` or `localeCompare` where members must agree on the order.
- Tree rows: `ui/treeKeys.ts`; other single-tab-stop rows: `moveFocus` (`ui/rovingFocus.ts`).
- Comparing against a value from outside (a sender, a hash): keep `!x || x.a !== b`; `x?.a !== b` passes when both
  sides are undefined.

When a correction applies to one place, check every place with the same pattern, and add the shared piece to this list.
