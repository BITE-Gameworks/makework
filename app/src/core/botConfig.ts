// A bot row's settings (`config`, JSON text), read the same way everywhere: by the runner, the settings card, the
// leader bot and the ledger's policy. Plain functions with no imports, so node-side code can use them too.

// The settings as an object; {} for a missing or unreadable value.
export function botConfig(row: Readonly<Record<string, unknown>> | undefined | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(row?.config || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Whether the bot can be given tasks and issues (Workspace settings > Bots); off unless turned on.
export const botAssignable = (row: Readonly<Record<string, unknown>> | undefined | null): boolean => botConfig(row)._assignable === true;

// The leader bot (its member id) a helper bot belongs to; NaN for a bot that is no helper.
export const botParent = (row: Readonly<Record<string, unknown>> | undefined | null): number => Number(botConfig(row)._parent ?? Number.NaN);
