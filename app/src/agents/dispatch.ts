import type { Job } from "./jobs";

// How a leader hands work to its helpers. Each running helper registers a worker here (they all run on the leader's
// host device); the leader sends a task and waits for the helper's report, or for the helper to fail. Nothing is stored.
export interface HelperTask {
  instruction: string;
  channelId: number;
  threadId: number | null;
  leader: { id: number; name: string; request: string };
  // The leader's job for this request (the helper's job hangs under it); everything here runs on one device.
  parent?: Job;
}
// `ok` is false when the helper says it can't do the task.
export interface HelperReport { ok: boolean; report: string }
export type Worker = (task: HelperTask) => Promise<HelperReport>;

const workers = new Map<number, Worker>();

export function registerWorker(botUserId: number, worker: Worker): () => void {
  workers.set(botUserId, worker);
  return () => { if (workers.get(botUserId) === worker) workers.delete(botUserId); };
}

export const startWaitMs = 20_000;
export const reportWaitMs = 5 * 60_000;
const usualLimits: Readonly<{ start: number; report: number }> = { start: startWaitMs, report: reportWaitMs };

// Waits for a helper that was just powered on to start, then for its report. A helper that doesn't start, throws or
// takes too long is reported as failed instead of holding the leader up.
export async function dispatch(botUserId: number, task: HelperTask, limits = usualLimits): Promise<HelperReport> {
  const until = Date.now() + limits.start;
  while (!workers.has(botUserId)) {
    if (Date.now() > until) return { ok: false, report: "The helper did not start." };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      workers.get(botUserId)!(task),
      new Promise<HelperReport>((resolve) => { timer = setTimeout(() => resolve({ ok: false, report: "The helper took too long." }), limits.report); }),
    ]);
  } catch (e) {
    return { ok: false, report: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
