// The job an agent is working on right now: lets it be stopped and keeps a token cap. A helper's job hangs under its
// leader's, so stopping the leader stops the helpers and their tokens count towards the leader's cap.
import { createStore } from "solid-js/store";

export const defaultTokenCap = 50_000;

// Thrown when a job was stopped or ran over its cap; the message says which.
export class JobEnded extends Error {}

export interface Job {
  signal: AbortSignal;
  asker: number;
  add(tokens: number): void;
  // Throws JobEnded once the job was stopped or is over its cap.
  check(): void;
  end(): void;
}

type Entry = { controller: AbortController; tokens: number; cap: number; asker: number; job?: Job };
// A bot's jobs, oldest first: two people can ask the same bot at once, and both jobs run.
const jobs = new Map<number, Entry[]>();
const [working, setWorking] = createStore<Record<number, true>>({});

export const isWorking = (botUserId: number): boolean => working[botUserId] === true;
const newest = (botUserId: number): Entry | undefined => jobs.get(botUserId)?.at(-1);

// A cap of 0 means no limit. A helper whose leader was stopped already starts stopped.
export function beginJob(botUserId: number, asker: number, cap: number, parent?: Job): Job {
  const controller = new AbortController();
  const entry: Entry = { controller, tokens: 0, cap, asker };
  jobs.set(botUserId, [...(jobs.get(botUserId) ?? []), entry]);
  setWorking(botUserId, true);
  const stopWithParent = () => controller.abort();
  if (parent?.signal.aborted) controller.abort();
  else parent?.signal.addEventListener("abort", stopWithParent);
  const job: Job = {
    signal: controller.signal,
    asker,
    add(tokens) {
      entry.tokens += tokens;
      parent?.add(tokens);
    },
    check() {
      if (controller.signal.aborted) throw new JobEnded("Stopped.");
      if (entry.cap > 0 && entry.tokens > entry.cap)
        throw new JobEnded(`This job used ${entry.tokens} tokens, over the limit of ${entry.cap}.`);
    },
    end() {
      parent?.signal.removeEventListener("abort", stopWithParent);
      const left = (jobs.get(botUserId) ?? []).filter((e) => e !== entry);
      if (left.length) jobs.set(botUserId, left);
      else {
        jobs.delete(botUserId);
        setWorking(botUserId, undefined as never);
      }
    },
  };
  entry.job = job;
  return job;
}

// The job a bot started last, if it works on any.
export const currentJob = (botUserId: number): Job | undefined => newest(botUserId)?.job;

// Who asked for the job a bot started last, if it works on one.
export const askerOf = (botUserId: number): number | undefined => newest(botUserId)?.asker;

// Stops a bot's jobs, or with `asker` only the ones that member asked for. True when there was a job to stop.
export function stopJob(botUserId: number, asker?: number): boolean {
  const entries = (jobs.get(botUserId) ?? []).filter((entry) => asker === undefined || entry.asker === asker);
  for (const entry of entries) entry.controller.abort();
  return entries.length > 0;
}
