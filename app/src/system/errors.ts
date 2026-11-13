// The exception kinds system/backend.ts turns into error codes.

export class InvalidRequest extends Error {}

// A JSON list of row ids from a request ("[3, 7]"), or InvalidRequest saying what was wrong.
export function idList(value: unknown, what: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new InvalidRequest(`'${what}' must be a JSON list of ids.`);
  }
  if (!Array.isArray(parsed) || !parsed.every((id) => Number.isSafeInteger(id))) throw new InvalidRequest(`'${what}' must be a JSON list of ids.`);
  return parsed as number[];
}

export class AccessDenied extends Error {}

export class Failed extends Error {}
