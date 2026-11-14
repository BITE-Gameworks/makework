# Developing MakeWork

## Setting up

You need:

1. **Node.js 24** and npm 11. Any installer works; [fnm](https://github.com/Schniz/fnm) is one (`fnm install 24`). In a
   non-login shell without `node`, `eval "$(fnm env)"` puts it on the PATH.
2. **Git.**
3. **Rust, through [rustup](https://rustup.rs)**, for the browser channel's ad blocker (Brave's engine, `adblock-rs`,
   is compiled when it is installed). Use rustup rather than a distribution's `rustc`: the engine asks for a specific
   Rust version, which rustup downloads by itself.
   - **Windows:** run `rustup-init.exe` and accept its offer to install the Visual Studio C++ build tools (or install
     "Desktop development with C++" from the
     [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) yourself).
   - **Linux:** `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, plus a C compiler
     (`build-essential` on Debian and Ubuntu).

Then:

```sh
cd app
npm install
npm run dev:desktop   # the desktop app; npm run dev:web for the browser version on http://localhost:1420
```

Without Rust, `npm install` still works and the app runs, but ad blocking is off (browser channels say so). Install
Rust, then run `npm rebuild adblock-rs` in `app/` and restart.

npm 11 runs install scripts only for packages listed under `allowScripts` in `app/package.json`. A new package with an
install script needs `npm install-scripts approve <package>`. After installing, `app/scripts/clean-modules.mjs` deletes
adblock-rs's Cargo build folder (about 200 MB). Deprecated packages deep in electron-builder's and mediasoup's
dependencies are replaced through `overrides` in `app/package.json`; don't run `npm audit fix --force`, which "fixes"
them by going back to electron-builder 24.

## Commands (in `app/`)

| Command | What it does |
|---|---|
| `npm run dev:web` | Browser dev server on http://localhost:1420 |
| `npm run dev:desktop` | Electron window; starts the web dev server itself and restarts Electron when `electron/main.js` or `preload.cjs` change. `MAKEWORK_DEV_PORT` runs a second copy beside one on 1420; arguments after `--` go to Electron |
| `npm run typecheck` | `tsc` over `src` and `tests` |
| `npm run lint` | The rules a pattern can check (`scripts/lint.mjs`); CI runs it |
| `npm test` | Unit tests (vitest, node environment) |
| `npm run coverage` | Unit tests with coverage into `app/coverage/` |
| `npm run build:web` | Typecheck of `src` only, then the web build into `app/dist` |
| `npm run build:node` | The node into `dist-node/` (see `nodes.md`); `npm run node -- <command>` builds and runs it |
| `npm run pack-plugins` | Packs `examples/plugins/*` into `.mwp` files |
| `npm run bump_version -- minor\|major` | Raises the version (below) |

Editing a `.ts` file reloads the whole page in dev (a plugin in `vite.config.ts`): hot-swapping state modules left old
timers and subscriptions running. Keep module-level state and side effects in `.ts` files, not in `.tsx` components.

The built app has a Content Security Policy (`vite.config.ts`); the dev server has none. Check anything that loads from
a new place or a new custom scheme in a build.

## Building packages

In `app/`; everything goes to `app/release/`.

| Command | Makes | Needs |
|---|---|---|
| `npm run build:linux` | AppImage, deb, rpm | Linux; `rpm` (`rpmbuild`) on Debian or Ubuntu |
| `npm run build:deb` / `build:rpm` | one of them | as above |
| `npm run build:flatpak` | `.flatpak` bundle | `flatpak-builder` and the Flathub remote added with `--user`; the first build installs the Electron base app and SDK, about 1 GB |
| `npm run build:win` | NSIS installer | Windows (from Linux only with wine) |
| `npm run build:mac` | dmg for this Mac's processor | macOS |
| `npm run build:desktop` | this system's default targets | |
| `npm run build:android` | `MakeWork-<version>.apk` (below) | JDK 21 and the Android SDK (platform 36), `ANDROID_HOME` set |
| `npm run build:browser` | the browser version to host (`dist/`), without ffmpeg.wasm (over Cloudflare Pages' 25 MiB file limit) | |

electron-builder packages only the `build.files` whitelist in `package.json`: a new file the main process imports must
be added there, and tests stay out of it. The desktop packages aren't code signed: Windows shows SmartScreen's warning, macOS gets an
ad-hoc signature. The Android app is a Capacitor wrapper of the web build (`capacitor.config.json`, `app/android/`); no
iOS build, which needs a Mac.

The APK is signed with the release key when `MAKEWORK_ANDROID_KEYSTORE` names it (with
`MAKEWORK_ANDROID_KEYSTORE_PASSWORD`, and `MAKEWORK_ANDROID_KEY_ALIAS` when it isn't `makework`), else with this
computer's debug key. Android installs an update only when it is signed like the installed app, so every published
APK must use the release key: losing it means people have to uninstall to update. The release workflow takes it from
the repository's secrets `ANDROID_KEYSTORE` (the keystore, base64), `ANDROID_KEYSTORE_PASSWORD` and
`ANDROID_KEY_ALIAS`. Without the Android Studio IDE, the SDK comes from Google's command line tools:
`sdkmanager --sdk_root=$ANDROID_HOME "platform-tools" "platforms;android-36" "build-tools;36.0.0"`.

A signed local build, with the keystore and a `signing.env` holding the three variables kept outside the repository
(for example in `~/.local/share/makework/android/`), and `JAVA_HOME` pointing at JDK 21 if it isn't the default:

```sh
cd app
set -a; . ~/.local/share/makework/android/signing.env; set +a
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=~/Android/Sdk npm run build:android
```

The APK lands in `app/release/`. Install it with `adb install -r app/release/MakeWork-<version>.apk`, or copy it to the
phone. To read a key's SHA-1: `keytool -list -v -keystore <keystore> -alias makework`, or for a built APK
`apksigner verify --print-certs <apk>` (from the SDK's `build-tools`).

Google sign-in on Android needs an Android OAuth client in the same Google Cloud project as the web client, with the
package name `com.makework.app` and the SHA-1 of each key that signs a build (the release key, and the debug key for
debug builds). The app never uses that client's id: Google matches the app by package and signature, and the ID
token is for the web client. GitHub sign-in on Android comes back on the link `com.makework.app://github`, which the
user server must know (`user-server/worker.js`).

Icons come from `app/resources/icon.svg` (`app/scripts/icon.sh`). The same script makes the Android launcher icons and
splash screens from `app/resources/icon.png` (`app/scripts/android-icons.py`, Python with Pillow).

## Versions and releases

The version is `first.second.third` in `app/package.json`, the only place it is kept. The third number goes up by itself
on every push to `main` (`.github/workflows/version.yml`), which adds a commit on GitHub: run `git pull --rebase` before
your next push. The first two are raised by hand in `app/`:

```sh
npm run bump_version -- minor    # 1.2.8 -> 1.3.0
npm run bump_version -- major    # 1.2.8 -> 2.0.0
```

To release, push a tag with the current version (`git tag v1.2.7 && git push origin v1.2.7`).
`.github/workflows/release.yml` builds every package on GitHub's Linux, Windows and macOS runners (macOS for Intel and
Apple Silicon) and the APK, and puts them in a draft release with the node (`makework-node.tar.gz`), the servers
(`makework-user-server.tar.gz`, `makework-turn-server.tar.gz`, without MakeWork's own settings) and `latest.json`.
Started by hand from the Actions tab, it keeps the files as the run's artifacts. The desktop builds take Google's
desktop OAuth client secret from the repository secret `GOOGLE_DESKTOP_CLIENT_SECRET` (locally:
`VITE_GOOGLE_DESKTOP_CLIENT_SECRET` in `app/.env.local`); without it they offer no Google sign-in. Desktop apps read `latest.json` at
start and every 6 hours and offer an update when it names a newer version, so publish it after the packages.

## Code quality

- `npm run lint` holds the mechanical rules (native pickers, `autofocus`, `window.prompt`, clipboard writes, hex colors in
  CSS, `app.isPackaged`). A new mechanical rule goes there.
- SonarQube can scan the repository locally with a `sonar-project.properties` at the root (`npm run coverage` first,
  then `sonar-scanner`). The project's profiles extend "Sonar way comprehensive" with the rules that contradict how the
  code is written on purpose turned off (awaits in a loop, chained ternaries, nested template literals, `void`,
  assignments in expressions, `String()` of row values, async without await, tag over ARIA role). Mark a single finding
  that is by design in SonarQube with its reason, never with a `NOSONAR` comment.
