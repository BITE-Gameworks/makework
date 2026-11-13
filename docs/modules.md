# Code layout

Paths are relative to the repository root. The client is `app/` (TypeScript, SolidJS, Vite; Electron for desktop,
Capacitor for Android, a plain web build for browsers).

## How the parts fit

A workspace has no server of its own. Each member's app runs the workspace's **plugins** (tables plus functions) on its
own copy of the data: a log of signed commits, replayed through the same **policy** on every member and synced peer to
peer (`architecture.md`). UI code talks to that data only through `ApiClient` -> `Transport` (`api/`); it never builds
raw requests and never writes tables around the ledger.

A plugin has a **data side** (`system/`, run in the app by `system/backend.ts`, reached through `PluginClient`) and a
**client side** (`plugins/`: views, settings, agent skills). Plugins installed as `.mwp` packages use the same contract
(`plugins.md`).

## `app/src/`

- `api/` `Transport`, `ApiClient`, `PluginClient` (pinned to one plugin) and the request and answer types.
  `mock/transport.ts` is the in-app transport.
- `system/` the plugins' data side: channels, members, roles, chat, voice, files, tasks, sheets, design, diagram, docs,
  git, nodes, browser, bots, emoji, watch and the declared tables of installed plugins (`declared.ts`). Listed in
  `p2p/plugins.ts`. `artboard.ts` stays for old commits (decision 0022).
- `p2p/` serverless workspaces:
  - the log and its rules: `log.ts` signed commits, `ledger.ts` replay, `policy.ts` permission rules for every table,
    `permissions.ts`, `visibility.ts`, `chatKeys.ts`, `chatKeyring.ts`, `chatCrypto.ts` (decision 0021);
  - connecting: `sync.ts` `WorkspaceSync` (Trystero rooms, catch-up), `syncQueue.ts`, `roomGroup.ts`, `mesh.ts` (direct
    or relayed peers, decision 0015), `relays.ts`, `ice.ts` (TURN), `presence.ts`;
  - membership: `workspaces.ts` (create, join, leave), `invite.ts` (codes and per-invite rooms), `pair.ts` (adding a
    node from its code);
  - content: `content.ts` and `stream.ts` (file content between members), `deliveries.ts` (new uploads until a node has
    them), `placement.ts` and `pieces.ts` (which node keeps what), `diskView.ts` and `folderSync.ts` (the readable
    folder on disk);
  - nodes and calls: `nodes.ts`, `nodeGroups.ts`, `voice.ts` (mesh calls), `sfu.ts` and `sfuProtocol.ts` (calls through
    a node).
- `node/` the headless node (`nodes.md`): `main.ts` CLI, `host.ts`, `sfu.ts` and `sfuBridge.ts` (mediasoup).
- `core/` app state: `workspaces.ts`, `serverless.ts`, `navigation.ts` (tabs), `sidebar.ts` (unread, starred),
  `account.ts`, `identity.ts`, `recovery.ts`, `userServer.ts`, `vault.ts`, `syncedPrefs.ts`, `content.ts` and
  `stream.ts` (content by hash, `mwc:` refs), `files.ts`, `uploads.ts`, `presence.ts`, `links.ts` (`makework://` links,
  copied as `https://app.makework.dev/open/...`), `openLinks.ts`, `history.ts` (undo), `roles.ts`, `members.ts`,
  `notifier.ts`, `ui.ts` (overlays, side panel, `narrow`), `storage.ts` (localStorage JSON), `liveText.ts` (shared Yjs
  text), `power.ts` (power saving), `bots.ts` (the bot runner), `llm.ts`, `desktop.ts` (the desktop bridge).
- `plugins/` the client plugin system: `types.ts` (the contract, `ChannelContext`, export providers), `registry.ts`,
  `ChannelHost.tsx`, `PluginSettings.tsx`, `SandboxFrame.tsx`, and `builtin/<type>/` (chat, files, tasks, sheets,
  design, diagram, docs, code, git, browser, bots, agents). `builtin/canvas/` holds the camera, geometry, snapping,
  selection, export and touch helpers shared by design and diagram.
- `agents/` what agentic bots run on: `loop.ts` (the tool loop), `skillKit.ts` and the general `skills*.ts` (search,
  memory, web), `dispatch.ts`, `library.ts`, `locks.ts`, `images.ts` (`agents.md`).
- `shell/` the layout: `Shell`, `WorkspaceBar`, `ChannelBar`, `MainView`, `TabBar`, `SidePanel`, `Overlays`, settings
  pages, `Auth.tsx` (sign-in), `AccountSecurity.tsx`, `QuickSwitcher`, `channelMenu.tsx`, `userMenu.tsx`, the Nodes page
  and globe, `shortcuts.ts`.
- `messaging/` `MessageCard`, `MessageComposer` and `messageWindow.ts`, shared by chat channels and private messages.
- `dm/` private messages and friends. `voice/` calls, the mic chain, screen sharing and its quality. `watch/` watch
  parties (decision 0024).
- `editor/` `RichEditor`. `markdown/` rendering and emoji. `viewers/` file viewers.
- `theme/` themes, icons and icon packs, sounds. `ui/` shared components (see "Consistency" in `AGENTS.md`).
- `presets/` workspace presets ("Explore MakeWork"). `dev/` the dev meter.

## Other folders

- `app/electron/` the desktop main process: `main.js`, `preload.cjs`, `mirror.js` (readable folders), `gitOps.js`,
  `sharedBrowser.js`, `adblock.js`, `storage.js`, `files.js`, `codeTools.js` (code channels' run folders, language
  servers, terminals), `release.js`, `background.js`, `shareAudio.js` (`desktop.md`).
- `app/tests/` unit tests, mirroring `src/` (`testing.md`).
- `app/scripts/` build, lint, packaging and playtest scripts.
- `app/vendor/` patched copies of dependencies; read each README before upgrading the package it replaces
  (`trystero-core` especially).
- `examples/plugins/` installable `.mwp` examples, including the Ping-pong walkthrough in `plugins.md`.
- `user-server/` and `turn-worker/` the Cloudflare workers (`accounts.md`).
- `mesh-test/` containerized multi-instance tests (`testing.md`).
