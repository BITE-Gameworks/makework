// Catch-ups (a member's hello answered with the commits it lacks) wait in one first-in, first-out queue per process
// and only `limit` of them send at once, so hundreds of members reconnecting together (a node restarting) don't all
// get their whole history at the same moment. Each member has at most one entry, queued or sending: hellos meanwhile
// are ignored (the next one after it finished fills any gap), so the queue grows with the members online, never with
// the hellos received. Entries hold only how to work out the answer; the commits are gathered when the turn comes.
//
// A turn is one batch: a catch-up with more to send returns its next step, which goes to the back of the queue. A
// member that takes data slowly then holds a slot for one batch at a time instead of its whole catch-up (on an
// overloaded host the limit fell to 1 and one slow member kept the only slot for minutes, mesh-test s8).
//
// The limit adapts like TCP's congestion window (additive increase, multiplicative decrease): batches that go out
// quickly raise it by about one per round, a slow or failed batch halves it (at most once per `slowMs`, since the
// catch-ups running together all notice the same congestion). Servers in one process share it: they share the
// uplink.

export type CatchUpRun = {
  // How long one batch took to go out and whether it did.
  report(ms: number, ok: boolean): void;
  // The member left or the workspace closed: stop sending.
  dropped(): boolean;
};
// Resolves with the next step when there is more to send.
export type CatchUp = (run: CatchUpRun) => Promise<CatchUp | void>;

export type SchedulerOptions = { start: number; min: number; max: number; fastMs: number; slowMs: number; now: () => number };

const defaults: SchedulerOptions = { start: 4, min: 1, max: 64, fastMs: 2_000, slowMs: 5_000, now: () => performance.now() };

export class SyncScheduler {
  // Map keeps insertion order: a next step put back lands at the end.
  private readonly queue = new Map<string, CatchUp>();
  private readonly running = new Map<string, { dropped: boolean }>();
  private allowed: number;
  private lastDecrease = -Infinity;
  private readonly options: SchedulerOptions;

  constructor(options: Partial<SchedulerOptions> = {}) {
    this.options = { ...defaults, ...options };
    this.allowed = this.options.start;
  }

  get limit(): number {
    return Math.floor(this.allowed);
  }

  // "busy": that member already has a catch-up queued or sending.
  enqueue(key: string, job: CatchUp): "queued" | "busy" {
    if (this.running.has(key) || this.queue.has(key)) return "busy";
    this.queue.set(key, job);
    this.pump();
    return "queued";
  }

  drop(key: string): void {
    this.queue.delete(key);
    const run = this.running.get(key);
    if (run) run.dropped = true;
  }

  // Every entry of one server (keys start with its prefix), when it closes.
  dropPrefix(prefix: string): void {
    for (const key of [...this.queue.keys(), ...this.running.keys()]) if (key.startsWith(prefix)) this.drop(key);
  }

  stats(): { queued: number; active: number; limit: number } {
    return { queued: this.queue.size, active: this.running.size, limit: this.limit };
  }

  private pump() {
    while (this.running.size < this.limit && this.queue.size > 0) {
      const [key, job] = this.queue.entries().next().value!;
      this.queue.delete(key);
      const state = { dropped: false };
      this.running.set(key, state);
      const run: CatchUpRun = { report: (ms, ok) => this.report(ms, ok), dropped: () => state.dropped };
      void Promise.resolve()
        .then(() => job(run))
        .then((next) => {
          if (next && !state.dropped) this.queue.set(key, next);
        })
        .catch((e) => console.warn("Catch-up failed:", e))
        .finally(() => {
          this.running.delete(key);
          this.pump();
        });
    }
  }

  private report(ms: number, ok: boolean) {
    const { min, max, fastMs, slowMs, now } = this.options;
    if (ok && ms <= fastMs) {
      this.allowed = Math.min(max, this.allowed + 1 / this.allowed);
      this.pump();
    } else if ((!ok || ms > slowMs) && now() - this.lastDecrease > slowMs) {
      this.lastDecrease = now();
      this.allowed = Math.max(min, this.allowed / 2);
    }
  }
}

// The one every workspace in this process shares.
export const syncScheduler = new SyncScheduler();
