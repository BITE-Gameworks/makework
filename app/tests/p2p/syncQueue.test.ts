import { describe, expect, it } from "vitest";
import { SyncScheduler, type CatchUp, type CatchUpRun } from "../../src/p2p/syncQueue";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// A catch-up that runs until `finish` is called, recording its name and the run when it starts.
function gate(started: string[], runs: Map<string, CatchUpRun>, name: string) {
  let finish = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));
  return {
    job: async (run: CatchUpRun) => {
      started.push(name);
      runs.set(name, run);
      await done;
    },
    finish: () => finish(),
  };
}

describe("sync scheduler", () => {
  it("serves catch-ups first in, first out, at most `limit` at once", async () => {
    const scheduler = new SyncScheduler({ start: 2 });
    const started: string[] = [];
    const runs = new Map<string, CatchUpRun>();
    const jobs = ["a", "b", "c", "d"].map((name) => gate(started, runs, name));
    jobs.forEach((j, i) => scheduler.enqueue(`s:${i}`, j.job));
    await tick();
    expect(started).toEqual(["a", "b"]);
    expect(scheduler.stats()).toEqual({ queued: 2, active: 2, limit: 2 });
    jobs[1].finish();
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    jobs[0].finish();
    jobs[2].finish();
    await tick();
    expect(started).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps one entry per member: hellos while it is queued or sending are ignored", async () => {
    const scheduler = new SyncScheduler({ start: 1 });
    const started: string[] = [];
    const runs = new Map<string, CatchUpRun>();
    const first = gate(started, runs, "first");
    expect(scheduler.enqueue("s:busy", first.job)).toBe("queued");
    expect(scheduler.enqueue("s:busy", gate(started, runs, "again").job)).toBe("busy");
    expect(scheduler.enqueue("s:x", gate(started, runs, "x").job)).toBe("queued");
    expect(scheduler.enqueue("s:x", gate(started, runs, "x again").job)).toBe("busy");
    expect(scheduler.stats().queued).toBe(1);
    first.finish();
    await tick();
    expect(started).toEqual(["first", "x"]);
  });

  it("gives each catch-up one batch per turn: the next step goes to the back of the queue", async () => {
    const scheduler = new SyncScheduler({ start: 1 });
    const turns: string[] = [];
    // A catch-up of `batches` steps, each recording its turn.
    const steps = (name: string, batches: number, i = 1): CatchUp => async () => {
      turns.push(`${name}${i}`);
      if (i < batches) return steps(name, batches, i + 1);
    };
    scheduler.enqueue("s:slow", steps("a", 3));
    scheduler.enqueue("s:b", steps("b", 1));
    scheduler.enqueue("s:c", steps("c", 2));
    for (let i = 0; i < 10; i++) await tick();
    expect(turns).toEqual(["a1", "b1", "c1", "a2", "c2", "a3"]);
    expect(scheduler.stats()).toEqual({ queued: 0, active: 0, limit: 1 });
  });

  it("drops a member's entry when they leave, and marks a running one", async () => {
    const scheduler = new SyncScheduler({ start: 1 });
    const started: string[] = [];
    const runs = new Map<string, CatchUpRun>();
    const a = gate(started, runs, "a");
    scheduler.enqueue("1:a", a.job);
    scheduler.enqueue("1:b", gate(started, runs, "b").job);
    scheduler.enqueue("2:c", gate(started, runs, "c").job);
    await tick();
    scheduler.dropPrefix("1:");
    expect(runs.get("a")!.dropped()).toBe(true);
    a.finish();
    await tick();
    expect(started).toEqual(["a", "c"]);
  });

  it("raises the limit while batches go out fast and halves it on a slow or failed one", () => {
    let now = 0;
    const scheduler = new SyncScheduler({ start: 4, min: 1, max: 8, fastMs: 2_000, slowMs: 5_000, now: () => now });
    let run!: CatchUpRun;
    scheduler.enqueue("s:a", async (r) => {
      run = r;
      await new Promise(() => {});
    });
    return tick().then(() => {
      for (let i = 0; i < 4; i++) run.report(100, true);
      expect(scheduler.limit).toBe(4);
      for (let i = 0; i < 100; i++) run.report(100, true);
      expect(scheduler.limit).toBe(8);
      now = 10_000;
      run.report(100, false);
      expect(scheduler.limit).toBe(4);
      // Catch-ups running together notice the same congestion: one decrease per `slowMs`.
      run.report(9_000, true);
      expect(scheduler.limit).toBe(4);
      now = 16_000;
      run.report(9_000, true);
      expect(scheduler.limit).toBe(2);
      for (const t of [30_000, 40_000, 50_000]) {
        now = t;
        run.report(0, false);
      }
      expect(scheduler.limit).toBe(1);
    });
  });
});
