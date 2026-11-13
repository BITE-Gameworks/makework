// Which messages run together under one header, and where a new day starts. Used by every message list.
const groupMs = 5 * 60_000;

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function startsNewDay(previous: { createdAt: string } | undefined, createdAt: string): boolean {
  return !previous || !sameDay(new Date(previous.createdAt), new Date(createdAt));
}

export function continuesFrom(previous: { authorId: unknown; createdAt: string } | undefined, message: { authorId: unknown; createdAt: string }): boolean {
  if (!previous || previous.authorId !== message.authorId) return false;
  const gap = new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime();
  return gap >= 0 && gap < groupMs && !startsNewDay(previous, message.createdAt);
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function dayLabel(iso: string, today = new Date()): string {
  const day = new Date(iso);
  if (sameDay(day, today)) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(day, yesterday)) return "Yesterday";
  return day.toLocaleDateString([], {
    weekday: "long", month: "long", day: "numeric", ...(day.getFullYear() !== today.getFullYear() && { year: "numeric" }),
  });
}
