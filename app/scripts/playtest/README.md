# Playtesting agents in the running app

Drives the dev app over CDP (Chrome DevTools Protocol) so a person can watch while a script plays the workspace owner.

```
cd app
MAKEWORK_DEV_PORT=1430 npm run dev:desktop -- --user-data-dir=/tmp/mw-playtest --remote-debugging-port=9223 --mute-audio
```

- Readable folders go to `~/MakeWork-dev` whatever the profile: also set `HOME` to a throwaway folder, or the run adds a workspace folder there.
- Use a throwaway `--user-data-dir`; sign in with "Skip, use MakeWork offline" (no account needed).
- `node scripts/playtest/cdp.mjs eval "<js>"` runs JavaScript in the page; `shot out.png` takes a screenshot; `click x y` clicks (CSS pixels).
- `scripts/playtest/run.sh "<async js using LH>"` loads `lh.js` first. `LH.init('Name')` finds the workspace and its bots by name,
  `LH.say(channel, text)` posts as the owner (`@Nick` becomes a mention), `LH.task(channel, text)` posts and waits until the bots
  go quiet, `LH.log('Nick')` is the bot's log, `LH.read(plugin, table)` reads data, `LH.render('design-channel')` draws a design.
  `render.sh <channel> out.png` saves that picture.
- The app modules are reachable through `import('/src/core/...')` in the page (Vite dev), so setup like creating a workspace is
  `(await import('/src/core/serverless.ts')).createServerless('Name')`; turn the agents plugin on with
  `(await import('/src/plugins/registry.ts')).setEnabled('makework.agents', true)`.

Gotchas (2026-10-17): editing a `.ts` file reloads the page and restarts the bots, so a message sent in that moment gets no answer
(wait for "Started on this device" in the bot log). The design canvas screenshotted as pure black although its DOM was right, so
check drawings with `render.sh`. Tool calls that wait for a bot need a long timeout; keep each test under 15 minutes.
