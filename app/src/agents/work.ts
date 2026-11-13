// What an agent changed in its last job, so it can be undone as one step. The commits are the bot's own (marked `as`
// in the signed log), found again by time; nothing about them is stored here besides the window.
export interface Work { from: number; to: number; bots: number[]; asker: number }

const last = new Map<number, Work>();

export function beginWork(botUserId: number, asker: number, bots: number[] = [botUserId]): void {
  last.set(botUserId, { from: Date.now() - 50, to: 0, bots, asker });
}

// Undone: it can't be undone twice.
export function lastWorkDone(botUserId: number): void {
  last.delete(botUserId);
}

export function endWork(botUserId: number): void {
  const work = last.get(botUserId);
  if (work) work.to = Date.now();
}

export const lastWork = (botUserId: number): Work | undefined => last.get(botUserId);
