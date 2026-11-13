// Commands the page asks this computer to run. The user answers in a dialog of the main process, which script in the
// page can't answer for, and the answer is kept here, out of the page's reach. No Electron imports, so tests can load this.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

const shownChars = 2000;
const shownLines = 12;

// As the dialog shows it. Lines stay lines, since a shell runs each on its own; blank lines and long runs of spaces go,
// and what doesn't fit is said, so nothing can be pushed out of sight.
export function commandText(command) {
  const lines = String(command).split(/\r\n|[\n\r\v\f\u2028\u2029]/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const text = lines.slice(0, shownLines).join("\n");
  const shown = text.length > shownChars ? text.slice(0, shownChars) : text;
  const hiddenLines = Math.max(0, lines.length - shownLines);
  const hiddenChars = text.length - shown.length;
  if (!hiddenLines && !hiddenChars) return shown;
  return `${shown}\n... (and ${[hiddenLines && `${hiddenLines} more lines`, hiddenChars && `${hiddenChars} more characters`].filter(Boolean).join(", ")})`;
}

async function readApproved(file) {
  try {
    const list = JSON.parse(await fs.readFile(file, "utf8"));
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

// `ask(question)` resolves true when the user agreed.
export function createCommandApproval({ file, ask }) {
  let loading = null;
  const approved = () => (loading ??= readApproved(file));
  let writing = Promise.resolve();
  // Whole or not at all: a crash while writing leaves the last good file.
  const save = () => {
    writing = writing.catch(() => {}).then(async () => {
      const part = `${file}.part`;
      await fs.writeFile(part, JSON.stringify([...(await approved())]), { mode: 0o600 });
      await fs.rename(part, file);
    });
    return writing;
  };
  return {
    // `what` identifies exactly what would run, and where: any change to it asks again.
    async require(what, question) {
      const key = createHash("sha256").update(JSON.stringify(what)).digest("hex");
      if ((await approved()).has(key)) return;
      if (!(await ask(question))) throw new Error("Not run: you cancelled it.");
      (await approved()).add(key);
      await save();
    },
  };
}
