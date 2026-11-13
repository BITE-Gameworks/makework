# MakeWork

An extensible communication and collaboration app. Workspaces hold channels for chat, voice and video calls, screen
sharing, files, tasks, sheets, docs, designs, diagrams, code, version control and a shared browser, plus bots and
agents. There is no workspace server: members keep a workspace's data as a log of signed changes and sync it peer to
peer, with optional always-on **nodes** for files and large calls.

The app is in `app/` (TypeScript, SolidJS, Vite; Electron for desktop, Capacitor for Android, and a web build).
`user-server/` and `turn-worker/` are the two small Cloudflare workers for accounts and TURN credentials.

## Installing

Each [release](https://github.com/BITE-Gameworks/makework/releases) has a package for every platform. None of them is
code signed yet.

- **Ubuntu, Linux Mint, Debian:** `sudo apt install ./makework_<version>_amd64.deb`. It recommends `git`, which git
  channels need.
- **Fedora:** `sudo dnf install ./makework-<version>.x86_64.rpm`.
- **Flatpak (any distribution, Fedora Atomic and Bazzite too):**
  `flatpak install --user ./MakeWork-<version>-x86_64.flatpak`. It needs the Flathub remote for its runtime
  (`flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo`).
- **AppImage (any distribution, no install):** make it executable and run it. Ubuntu 24.04 needs `libfuse2t64`.
- **Windows:** run `MakeWork-Setup-<version>.exe`. SmartScreen warns about an unknown publisher: More info > Run anyway.
- **macOS:** `MakeWork-<version>-arm64.dmg` for Apple Silicon, `-x64` for Intel. Drag MakeWork to Applications. As it
  isn't notarized, the first start needs right-click > Open.
- **Browser:** https://app.makework.dev.

## Building from source

Node.js 24, Git, and Rust through rustup (for the ad blocker; optional). Then:

```sh
cd app
npm install
npm run dev:desktop   # or npm run dev:web for the browser version
```

Details, packages and releases: [docs/development.md](docs/development.md).

## Documentation

- [docs/](docs/README.md): how MakeWork works, its code layout, plugins, nodes, accounts and testing.
- [AGENTS.md](AGENTS.md): how to work on the code (for people and coding agents).
- [docs/plugins.md](docs/plugins.md): writing plugins.
- [docs/nodes.md](docs/nodes.md): running a node.

## License

MakeWork is free software under the [GNU General Public License v3.0](LICENSE).
