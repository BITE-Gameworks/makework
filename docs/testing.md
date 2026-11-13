# Testing

## Unit tests (`app/tests/`)

`npm test` runs vitest in a plain node process (`vite.config.ts`): no DOM, no `localStorage`, no `indexedDB`. Tests
mirror `src/` (`tests/core/sidebar.test.ts` tests `src/core/sidebar.ts`); new tests go there, never next to the code.
`tsconfig.json` includes `tests`, so `npm run typecheck` covers them. Tests are never part of a build.

The workers run in process too: `tests/core/userServer.test.ts` and `tests/p2p/turnWorker.test.ts` drive
`user-server/worker.js` and `turn-worker/worker.js` on an in-memory copy of the user server's database (`tests/d1.ts`,
every migration on `node:sqlite`), with mail and GitHub caught by a stubbed `fetch`.

### Serverless code in node

- Seed rows directly: `const backend = new MockBackend({ userId }); backend.load(files);` then
  `backend.data("files").insert("files_entries", { ... })`. Missing columns become `null` and an unknown column throws.
  Call `insert` as a method: an extracted `const insert = store.insert` is unbound. Read the table's columns in
  `system/<plugin>.ts` first.
- A module that takes a `WorkspaceSync` can get a room-less fake when the test never syncs:
  `{ room: null, onPeers: () => () => {} } as unknown as WorkspaceSync`.
- `core/content.ts` stores don't exist in node: mock `deleteContent` and `hasContent` with `vi.hoisted` and `vi.mock`,
  and close instances in `afterEach` so their timers never reach IndexedDB.
- The fake network (`tests/p2p/fakeNetwork.ts`) delivers at once, but `Mesh` sends through a per-peer outbox: await
  `vi.advanceTimersByTimeAsync(...)` after a change before reading routes.
- Trystero keeps the first action of a name; a second `makeAction` with the same name gets the first one back. One
  owner per channel.
- `fakeNetwork.ts` replaces Trystero, so races inside Trystero never show there. `tests/vendor/trysteroCore.test.ts`
  runs the real (patched) core over werift instead.
- A stub of a third-party system (mediasoup, RTCPeerConnection, Trystero) must reject what the real one rejects, or a
  test passes against a lie. Encode the contract in the stub's types (`tests/node/sfu.test.ts`).

## Mesh test (`mesh-test/`)

Many app instances and nodes in containers, driven over the Chrome DevTools Protocol, on simulated networks. It checks
joins, sync, files, calls and load at sizes unit tests can't. Scenarios, setup and reports: `mesh-test/README.md`.
Headless instances must run with `--mute-audio` (Chromium's fake microphone beeps on the speakers).

## Agent playtests

`app/scripts/playtest/README.md`: drives the dev app over CDP so a person can watch a script play the workspace owner
while the bots work.

## Trying things by hand

- Run a second app beside the first: `MAKEWORK_DEV_PORT=1430 npm run dev:desktop -- --user-data-dir=/tmp/mw-second`.
  Each profile is its own "computer"; two copies can't share one profile (IndexedDB refuses the second).
- Readable folders go to `~/MakeWork-dev` in dev, whatever the profile: set `HOME` to a scratch folder for throwaway runs.
- A copy of real user data: extract it into a scratch `--user-data-dir`, set `HOME` to a scratch folder and block the
  network (`--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE localhost"`), or the copy joins the real workspaces' rooms.
- An offscreen Electron window never has focus; enable CDP `Emulation.setFocusEmulationEnabled` for anything that
  depends on focus.
- The dev meter (Ctrl+Alt+P) counts endless animations and frame work; `document.getAnimations()` over CDP names them.
