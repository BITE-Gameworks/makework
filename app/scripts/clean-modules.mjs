// After `npm install`: adblock-rs builds itself with Cargo and copies the result to js/index.node; its build folder
// (about 200 MB) is only Cargo's cache. Never fails the install: on Windows the compiler's helper (mspdbsrv) can
// keep files in it locked for a while after the build.
import { existsSync, rmSync } from "node:fs";

const adblock = new URL("../node_modules/adblock-rs/", import.meta.url);
if (existsSync(new URL("js/index.node", adblock))) {
  try {
    rmSync(new URL("target", adblock), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (e) {
    console.warn(`Left adblock-rs's build folder (node_modules/adblock-rs/target) in place: ${e.message}`);
  }
}
