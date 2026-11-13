// How busy calls are on this device, for call diagnostics: things that happen a few times while a call settles and
// then rarely. A call that keeps re-adding streams, renegotiating or failing connections shows it here, and a burst
// is logged once a minute.
export type Activity =
  | "streams received" | "streams sent" | "renegotiations" | "players started" | "call members changed"
  | "call mode changes" | "peers lost" | "connections failed";

const keepMs = 5 * 60_000;
const minuteMs = 60_000;
// More than this in a minute is churn, not a call settling.
const burst = 30;
const events = new Map<Activity, number[]>();
const warnedAt = new Map<Activity, number>();

export function noteActivity(kind: Activity): void {
  const now = Date.now();
  const times = (events.get(kind) ?? []).filter((at) => now - at < keepMs);
  times.push(now);
  events.set(kind, times);
  const lastMinute = times.filter((at) => now - at < minuteMs).length;
  if (lastMinute > burst && now - (warnedAt.get(kind) ?? 0) > minuteMs) {
    warnedAt.set(kind, now);
    console.warn(`Call: ${kind} ${lastMinute} times in the last minute`);
  }
}

// What happened to a workspace's calls on this device: links to call members opening and closing, connections
// carrying our media in trouble, members lost, mic streams ending or arriving again, the call's mode, catch-ups while
// in a call. Call diagnostics shows the last ones, so a call that went silent says what came just before (members on
// other networks). `peer`: the member's peer id, named where `{peer}` stands when shown. `warn`: a loss,
// also a console warning.
type CallEvent = { at: number; workspaceId: string; text: string; peer?: string };
const callEvents: CallEvent[] = [];
const callEventsKept = 60;

export function noteCallEvent(workspaceId: string, text: string, peer?: string, warn = false): void {
  callEvents.push({ at: Date.now(), workspaceId, text, peer });
  if (callEvents.length > callEventsKept) callEvents.splice(0, callEvents.length - callEventsKept);
  (warn ? console.warn : console.info)(`Call: ${peer ? text.replace("{peer}", () => `peer ${peer}`) : text}`);
}

// The workspace's events, newest first, each with its time. A replacer function: a name is text, never a pattern.
export function recentCallEvents(workspaceId: string, name: (peer: string) => string): string[] {
  return callEvents.filter((e) => e.workspaceId === workspaceId).reverse()
    .map((e) => `${new Date(e.at).toLocaleTimeString()} ${e.peer ? e.text.replace("{peer}", () => name(e.peer!)) : e.text}`);
}

// Counts for the last minute and the last five, and the page's memory where the browser tells it.
export function activitySummary(): Record<string, string | number> {
  const now = Date.now();
  const summary: Record<string, string | number> = {};
  for (const [kind, times] of events) {
    const recent = times.filter((at) => now - at < keepMs);
    if (recent.length) summary[`${kind[0].toUpperCase()}${kind.slice(1)} (1 min / 5 min)`] = `${recent.filter((at) => now - at < minuteMs).length} / ${recent.length}`;
  }
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  if (memory) summary["Page memory (MB)"] = Math.round(memory.usedJSHeapSize / 1_048_576);
  return summary;
}
