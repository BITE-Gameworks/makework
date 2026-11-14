# Desktop, browsers and operating systems

What the desktop app (`app/electron/`) and the different platforms need. Read this before touching `electron/` or disk
paths.

## Profiles and processes

- Installed builds use `~/.config/makework` (`%APPDATA%\makework`), dev runs `makework-dev`, test instances their
  `--user-data-dir`. One running copy per profile (`requestSingleInstanceLock`): a second start focuses the first.
- Electron's `app.isPackaged` is true for any executable not named electron(.exe), so the main process asks
  `installed` (`electron/installed.js`) instead; lint rule `is-packaged`.
- Vite only reloads the page; the main process and preload load at start. `dev:desktop` restarts Electron when
  `main.js` or `preload.cjs` change; otherwise the page calls IPC the main process lacks ("No handler registered").
  Show desktop errors with `desktopError(e)` (`core/desktop.ts`).
- A packaged build has no terminal: the page's console goes to `<userData>/logs/main.log` (rotated at 2 MB), turned on
  in dev with `MAKEWORK_LOG=1`. Ctrl+Shift+I opens DevTools.
- Never move a whole file through IPC or into one ArrayBuffer: Chromium kills the page for IPC messages over about
  128 MB and `fs.readFile` stops at 2 GiB. Use `core/stream.ts` chunks and `mwc://content/<hash>`.

## Git working copies

- The page reads only git folders the user picked in the dialog (`<userData>/git-folders.json`), through one handler
  per operation in `electron/gitOps.js`; nothing runs git with arguments from the page.
- A picked folder's checked-out submodules join that list when the page asks for them (`git:submodules`): main finds
  them from the folder's own last commit and checks each is a repository of its own inside it, never taking a path
  from the page.
- `git:prepare-submodules` clones the missing ones (only into a missing or empty folder, never through a link, always
  with git's plain checkout so a repository's own `update` command never runs) and puts each one that is on no branch
  on its branch, made at its commit or switched to only when it is at that commit, so no file changes. Opening a
  channel and importing do it; the background watch only reads.

## Windows

- View windows (a tab popped out) and terminal windows: decision 0009. Only the main window owns account-wide effects.
  Window controls float over the top right corner; dragging uses `data-drag-region`, and anything layered over a drag
  region needs `-webkit-app-region: no-drag`.

## Linux

- Taskbars (KDE, GNOME) take the name and icon from the `.desktop` file matching the app id (`makework`), not the
  window. `dev.js` writes a hidden dev copy to `~/.local/share/applications`. Don't rename `productName`: user data
  lives under it.
- `dev:desktop` runs with `--no-sandbox` because Ubuntu's AppArmor blocks the sandbox for the unpackaged binary; the deb
  ships an AppArmor profile.
- Screen share sound: `electron/shareAudio.js` makes a PipeWire virtual source while sharing and links every other
  app's output into it, so the call itself isn't recorded. Without PipeWire the share has no sound.
- Flatpak: `FLATPAK_ID` is set inside; its profile is under `~/.var/app/com.makework.app/`. The runtime has no git, so
  the bundle builds git itself (`build.flatpak` in `package.json`). Building it on Ubuntu 24.04 needs
  `kernel.apparmor_restrict_unprivileged_userns=0` and the Flathub remote added `--user`.
- Packages: the rpm turns off `/usr/lib/.build-id` links; the deb recommends git.

## Windows (the operating system)

- The taskbar button comes from the Start Menu shortcut carrying the window's AppUserModelID.
  `electron/windowsShortcut.js` gives dev runs their own id and themed icon; `dev:desktop` runs `MakeWork-dev.exe` so
  Task Manager names it.
- A file something has open can't be deleted: the main process deletes through `removeOrDefer` (`electron/files.js`).
  Names written to disk go through `safeSegment` (device names, trailing dots, reserved characters).
- Windows and macOS file names ignore case: never have two modules whose names differ only in case.

## macOS

- Ad-hoc signed (`identity: "-"`, Apple Silicon needs a signature) without the hardened runtime; the microphone and
  camera usage texts are in `extendInfo`.

## Graphics and power

- Laptops with two GPUs: Settings > Application > Graphics (`applyGpuChoice` in `electron/background.js`). "auto" asks
  for the low-power GPU on computers seen to have a battery. "On battery" comes from `powerMonitor`, not the Battery
  API.
- Power saving (`core/power.ts`, automatic on battery) stops or slows decorations that keep redrawing.

## Browsers and media

- Google blocks sign-in in embedded windows: Electron uses the system browser (`google:sign-in`).
- WebKit (Safari, Epiphany) delivers microphone audio about 20 dB quieter and can't switch outputs; voice levels are
  relative (`voice/state.ts`). Create and resume an AudioContext synchronously in the click handler, and connect
  analysers through to the destination.
- Chromium only feeds a remote WebRTC stream into Web Audio while a media element plays it (muted is fine).
- HEVC plays only with hardware decoding; `ui/VideoPlayer` detects a picture-less video and offers "Convert to play
  here" (ffmpeg.wasm, `core/videoConvert.ts`, cached per content hash).
- Some headsets deliver speech very quietly: the sent mic is auto-levelled (`voice/micProcessing.ts`), slowly enough
  that a short loud sound doesn't turn the voice down.
- "incorrect password for overlapping room" or "handshake timed out" between current builds means two peers'
  handshakes got out of step, never a wrong password. Never make every peer leave and rejoin a room at the same moment
  (`rotateSecret` keeps the old hub as a recovery room; `applyRooms` waits a random delay before rejoining).
- Join timing shows in the console: `[sync] <workspace>: looking for members`, `first member found after N s`,
  `server data received after N s`.
