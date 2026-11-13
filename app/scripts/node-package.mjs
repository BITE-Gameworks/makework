// Writes dist-node/package.json after `vite build` for the node: the packages the bundle leaves out, at the
// versions installed here, so `npm install --omit=dev` in dist-node makes it runnable on its own.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { isMain } from "./isMain.mjs";

// Deprecated packages under the node's dependencies that app replaces with a folder in app/vendor (its README says
// why). The node gets the same folder in dist-node/vendor, or a server's `npm install` fetches the deprecated
// package and warns about it. tests/scripts/node-package.test.ts fails when app replaces one under the node's
// dependencies that is missing here.
const standIns = ["node-domexception"];

/** The node's package.json, from app's package.json. */
export function nodePackage(app) {
  const version = (name) => app.devDependencies[name] ?? app.dependencies?.[name];
  // The same `file:` spec as dependency and override, like app's Squirrel stand-in: npm 10 (Node 22's) can't always
  // resolve an override's `$name` reference.
  const vendored = Object.fromEntries(standIns.map((name) => [name, `file:vendor/${name}`]));
  return {
    name: "makework-node",
    version: app.version,
    private: true,
    type: "module",
    license: app.license,
    bin: { "makework-node": "makework-node.mjs" },
    engines: { node: ">=22" },
    scripts: { start: "node makework-node.mjs start" },
    dependencies: {
      werift: version("werift"),
      maxmind: version("maxmind"),
      mediasoup: version("mediasoup"),
      ...vendored,
    },
    overrides: vendored,
    // npm 11 runs only approved install scripts; mediasoup's fetches or builds the call worker a node needs.
    allowScripts: { mediasoup: true },
  };
}

if (isMain(import.meta.url)) {
  const app = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const pkg = nodePackage(app);
  writeFileSync(new URL("../dist-node/package.json", import.meta.url), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const name of standIns) {
    cpSync(new URL(`../vendor/${name}/`, import.meta.url), new URL(`../dist-node/vendor/${name}/`, import.meta.url), {
      recursive: true,
    });
  }
}
