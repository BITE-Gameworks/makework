# No Squirrel.Windows

`app-builder-lib` lists `electron-builder-squirrel-windows` as a peer, so npm installs it and its `electron-winstaller`
(about 32 MB, with `temp`, `rimraf@2` and `glob@7`, which npm warns about as deprecated). MakeWork builds Windows
installers with NSIS only, and `app-builder-lib` loads the Squirrel target only when asked for it, so this empty
package takes its place. It needs both entries in `app/package.json`, each with the same spec
`file:vendor/no-squirrel-windows`: the devDependency and the override. Without the override, every electron-builder
update brought the real package back (2026-11-10): `app-builder-lib` asks for its own exact version of the peer, and
this stand-in's version stays put. The override is spelled out rather than `$electron-builder-squirrel-windows`
because npm 10 can't resolve a `$` reference while it works out peer dependencies ("Unable to resolve reference" on
`npm dedupe`, and `npm ls` then calls every override invalid). Remove both entries if a Squirrel build is ever wanted.
