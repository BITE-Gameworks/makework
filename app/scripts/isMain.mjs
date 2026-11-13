// Whether a script was started with `node` rather than imported (by a test), so scripts can export their parts and run
// only when started. Compares real paths: node resolves symlinks in the started module's import.meta.url but not in
// process.argv[1], so a path through a symlink (/home -> /var/home on Fedora Atomic) made a plain comparison false
// and the script quietly did nothing.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True in the script node was started with; pass its `import.meta.url`. */
export function isMain(url) {
  const started = process.argv[1];
  if (!started) return false;
  try {
    return realpathSync(started) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
