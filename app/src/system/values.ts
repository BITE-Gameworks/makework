// The value rules for table columns: what a column of each type takes, and how values are stored.
import type { ColumnType } from "../api/types";
import { InvalidRequest } from "./errors";

export type StoredValue = string | number | boolean | Date | null;

const emojiRanges: [number, number][] = [
  [0x1f000, 0x1faff], [0x2600, 0x27bf], [0x2b00, 0x2bff],
  [0x231a, 0x231b], [0x2328, 0x2328], [0x23cf, 0x23cf], [0x23e9, 0x23fa],
  [0x200d, 0x200d], [0xfe0e, 0xfe0f], [0x20e3, 0x20e3], [0xe0020, 0xe007f],
];

const identifierPattern = /^[a-z_][a-z0-9_]{0,62}$/;

export function identifier(name: string): string {
  const standardized = name.trim().toLowerCase();
  if (!identifierPattern.test(standardized))
    throw new InvalidRequest(
      `Invalid name '${name}': use letters a-z, digits and '_', start with a letter or '_', max 63 characters.`);
  return standardized;
}

const hex = (code: number) => `\\u{${code.toString(16)}}`;
const forbidden = new RegExp(
  `[${emojiRanges.map(([first, last]) => `${hex(first)}-${hex(last)}`).join("")}\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]`, "u");
const plainAscii = /^[\x20-\x7e\t\n\r]*$/;

export function text(value: string): string {
  // Fast paths, for long values like data URLs.
  if (plainAscii.test(value)) return value.trim();
  const standardized = value.normalize("NFC").trim();
  if (!forbidden.test(standardized)) return standardized;
  for (const char of standardized) {
    const code = char.codePointAt(0)!;
    if (emojiRanges.some(([first, last]) => code >= first && code <= last))
      throw new InvalidRequest("Emojis are not allowed.");
    if (isControl(code) && char !== "\t" && char !== "\n" && char !== "\r")
      throw new InvalidRequest(`Control character U+${code.toString(16).toUpperCase().padStart(4, "0")} is not allowed.`);
  }
  return standardized;
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

const typeLabels: Record<ColumnType, string> = {
  text: "Text", int: "Integer", bigint: "BigInt", decimal: "Decimal", bool: "Boolean", timestamp: "Timestamp",
};

// Converts typed text the way the CLI does; the word null (any casing) means NULL.
export function parseValue(column: string, type: ColumnType, value: string): StoredValue {
  if (value.toLowerCase() === "null") return null;
  const invalid = () => new InvalidRequest(`'${value}' is not a valid ${typeLabels[type]} value for column '${column}'.`);
  const trimmed = value.trim();
  switch (type) {
    case "text":
      return value;
    case "int":
    case "bigint": {
      if (!/^[+-]?\d+$/.test(trimmed)) throw invalid();
      const n = Number(trimmed);
      if (type === "int" && (n < -(2 ** 31) || n >= 2 ** 31)) throw invalid();
      return n;
    }
    case "decimal": {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) throw invalid();
      return Number(trimmed);
    }
    case "bool": {
      const lower = trimmed.toLowerCase();
      if (lower !== "true" && lower !== "false") throw invalid();
      return lower === "true";
    }
    case "timestamp": {
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00` : trimmed.replace(" ", "T");
      const hasZone = /(z|[+-]\d\d:?\d\d)$/i.test(iso);
      const date = new Date(hasZone ? iso : `${iso}Z`);
      if (Number.isNaN(date.getTime())) throw invalid();
      return date;
    }
  }
}

// A JSON scalar for a column or argument of the type; strings are parsed, other mismatches throw.
export function convert(name: string, type: ColumnType, value: unknown, mismatch: () => Error): StoredValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return type === "text" ? text(value) : parseValue(name, type, value);
  switch (type) {
    case "int":
      if (Number.isInteger(value) && (value as number) >= -(2 ** 31) && (value as number) < 2 ** 31) return value as number;
      break;
    case "bigint":
      if (Number.isInteger(value)) return value as number;
      break;
    case "decimal":
      if (typeof value === "number") return value;
      break;
    case "bool":
      if (typeof value === "boolean") return value;
      break;
  }
  throw mismatch();
}

// Timestamps go out as ISO-8601 UTC without milliseconds, like the backend.
export function toJson(value: StoredValue): string | number | boolean | null {
  return value instanceof Date ? value.toISOString().replace(/\.\d{3}Z$/, "Z") : value;
}
