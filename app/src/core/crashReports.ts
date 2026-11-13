// Offers to report errors nobody handled. Nothing leaves this device on its own: the person sees the whole report in
// the feedback form first and chooses to send it. A report stays pending across a restart, since a crash can take
// down the page before it could ask.
import { desktop } from "./desktop";
import { openFeedback } from "./feedback";
import { showNotice } from "./notices";
import { readJson, removeKey, writeJson } from "./storage";
import { UserServerError } from "./userServer";
import { appVersion } from "./version";

const pendingKey = "mw.crash.pending";
const seenKey = "mw.crash.seen";
const maxSeen = 50;
const maxReportChars = 8000;

let asked = false;

// Keeps what a report needs (error, function and file names) and drops what could point at the person or their data.
// An email address is taken from where its name starts; the second form (a name of at most 64 characters) catches
// one glued to the text before it. A name of any length from any position would be tried from every position.
export function scrub(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)]*\/([^\s/)?#]*)(?:[?#][^\s)]*?)?(?=(?::\d+){0,2}(?:[\s)]|$))/gi, "$1")
    .replace(/(?<![\w.-])(?:[A-Za-z]:)?[\\/](?:[^\s\\/:()]+[\\/])+([^\s\\/:()]*)/g, "$1")
    .replace(/(?<![\w.+-])[\w.+-]+@[\w-]+\.[\w.-]+|[\w.+-]{1,64}@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[long value]");
}

export function crashText(error: unknown, where: string): string {
  const description = error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error);
  return scrub(`Where: ${where}\n${description}`).slice(0, maxReportChars);
}

// The same error on another line number or version isn't told apart by much: this is what "seen before" compares.
function signatureOf(report: string): string {
  const [where, error, frame] = report.split("\n");
  return `${appVersion}|${where}|${error}|${frame ?? ""}`.replace(/\d+/g, "#").slice(0, 300);
}

function ask(report: string): void {
  asked = true;
  writeJson(pendingKey, report);
  showNotice("MakeWork ran into a problem", "You can send a report to help fix it. You'll see all of it first, and nothing is sent unless you choose to.", [
    { label: "Review report", run: () => { removeKey(pendingKey); openFeedback(report); } },
    { label: "Not now", run: () => removeKey(pendingKey) },
  ]);
}

// Asks once per session, and only once for each kind of error.
export function reportCrash(error: unknown, where: string): void {
  if (asked) return;
  const report = crashText(error, where);
  const signature = signatureOf(report);
  const seen = readJson<string[]>(seenKey, []);
  if (seen.includes(signature)) return;
  writeJson(seenKey, [...seen, signature].slice(-maxSeen));
  ask(report);
}

// Requests fail all the time for ordinary reasons (offline, a refused permission); those aren't crashes.
function isExpected(reason: unknown): boolean {
  if (!(reason instanceof Error) || reason instanceof UserServerError || reason instanceof DOMException) return true;
  return reason instanceof TypeError && /fetch|network/i.test(reason.message);
}

export function startCrashReports(): void {
  if (import.meta.env.DEV) return;
  // Without an `error` the event is a browser note (ResizeObserver loops) or another origin's script.
  window.addEventListener("error", (event) => {
    if (event.error) reportCrash(event.error, "uncaught error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (!isExpected(event.reason)) reportCrash(event.reason, "unhandled rejection");
  });
  const pending = readJson<string | null>(pendingKey, null);
  if (pending) {
    ask(pending);
    return;
  }
  void desktop?.takeLastCrash?.().then((crash) => {
    if (!crash || asked) return;
    ask(`Where: the window's process ended\nReason: ${crash.reason}\nExit code: ${crash.exitCode}\nVersion then: ${crash.version}\nAt: ${crash.at}`);
  });
}
