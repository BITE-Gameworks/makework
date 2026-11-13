// "/when 15:00 Berlin": what a clock time somewhere is for other zones, and "/remind 20m text" durations.
const aliases: Record<string, string> = {
  utc: "UTC", gmt: "UTC", london: "Europe/London", berlin: "Europe/Berlin", paris: "Europe/Paris", madrid: "Europe/Madrid",
  rome: "Europe/Rome", amsterdam: "Europe/Amsterdam", athens: "Europe/Athens", helsinki: "Europe/Helsinki",
  stockholm: "Europe/Stockholm", warsaw: "Europe/Warsaw", moscow: "Europe/Moscow", istanbul: "Europe/Istanbul",
  kyiv: "Europe/Kyiv", lisbon: "Europe/Lisbon", dublin: "Europe/Dublin", cairo: "Africa/Cairo", lagos: "Africa/Lagos",
  johannesburg: "Africa/Johannesburg", nairobi: "Africa/Nairobi", dubai: "Asia/Dubai", tehran: "Asia/Tehran",
  karachi: "Asia/Karachi", delhi: "Asia/Kolkata", mumbai: "Asia/Kolkata", kolkata: "Asia/Kolkata", dhaka: "Asia/Dhaka",
  bangkok: "Asia/Bangkok", jakarta: "Asia/Jakarta", singapore: "Asia/Singapore", "hong kong": "Asia/Hong_Kong",
  shanghai: "Asia/Shanghai", beijing: "Asia/Shanghai", taipei: "Asia/Taipei", seoul: "Asia/Seoul", tokyo: "Asia/Tokyo",
  sydney: "Australia/Sydney", melbourne: "Australia/Melbourne", perth: "Australia/Perth", auckland: "Pacific/Auckland",
  honolulu: "Pacific/Honolulu", anchorage: "America/Anchorage", "los angeles": "America/Los_Angeles", la: "America/Los_Angeles",
  pst: "America/Los_Angeles", pacific: "America/Los_Angeles", denver: "America/Denver", mst: "America/Denver",
  chicago: "America/Chicago", cst: "America/Chicago", central: "America/Chicago", "new york": "America/New_York",
  nyc: "America/New_York", est: "America/New_York", eastern: "America/New_York", toronto: "America/Toronto",
  mexico: "America/Mexico_City", bogota: "America/Bogota", lima: "America/Lima", santiago: "America/Santiago",
  "sao paulo": "America/Sao_Paulo", "buenos aires": "America/Argentina/Buenos_Aires", cet: "Europe/Berlin",
  eet: "Europe/Athens", bst: "Europe/London", ist: "Asia/Kolkata", jst: "Asia/Tokyo",
};

// A zone from a city, a common abbreviation or an IANA name ("Europe/Berlin", "america/new_york"); null when unknown.
export function findZone(text: string): string | null {
  const key = text.trim().toLowerCase().replaceAll("_", " ");
  if (!key) return null;
  if (aliases[key]) return aliases[key];
  try {
    const iana = text.trim().replaceAll(" ", "_");
    return new Intl.DateTimeFormat("en", { timeZone: iana }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function offsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return (Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - at.getTime()) / 60_000;
}

// The moment when it is hour:minute on the day `now` has in `zone`.
export function zoneTime(zone: string, hour: number, minute: number, now: Date): Date {
  const local = new Date(now.getTime() + offsetMinutes(zone, now) * 60_000);
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute);
  const first = guess - offsetMinutes(zone, new Date(guess)) * 60_000;
  return new Date(guess - offsetMinutes(zone, new Date(first)) * 60_000);
}

// "15:00", "3pm", "3:30 pm", "now" -> hour and minute, or null.
export function parseClock(text: string): { hour: number; minute: number } | "now" | null {
  const t = text.trim().toLowerCase();
  if (t === "now") return "now";
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (minute > 59) return null;
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[3] === "pm" ? 12 : 0);
  } else if (hour > 23) return null;
  return { hour, minute };
}

export function clockIn(zone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).format(at);
}

const units: Record<string, number> = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, d: 86400, w: 604800 };

// "20m", "1h30m", "2d" -> milliseconds; null when it is not a duration.
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!/^(\d{1,9}\s*[a-z]+\s*)+$/.test(t)) return null;
  let total = 0;
  for (const m of t.matchAll(/(\d{1,9})\s*([a-z]+)/g)) {
    const unit = units[m[2]];
    if (!unit) return null;
    total += Number(m[1]) * unit;
  }
  return total > 0 ? total * 1000 : null;
}
