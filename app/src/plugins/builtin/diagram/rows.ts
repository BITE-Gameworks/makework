// Structured shapes: a UML class (and its kin) or a database table, drawn as a header and compartments of rows. Rows
// are typed the usual way ("+ find(id: int): User", "user_id bigint FK") and read into fields (parseRow), written back
// the same way (rowText), and laid out once (structureLayout) for the canvas, exports and connectors on rows.
import type { DiagramRow, DiagramShape, RowSection, ShapeKind, StructuredKind } from "./model";

export interface Structure {
  // Above the name, in guillemets ("interface" -> «interface»).
  stereotype?: string;
  // The name in italics (abstract) or underlined (an object, an instance).
  nameStyle?: "italic" | "underline";
  sections: RowSection[];
}

const structures: Record<StructuredKind, Structure> = {
  "uml-class": { sections: ["attributes", "operations"] },
  "uml-abstract": { nameStyle: "italic", sections: ["attributes", "operations"] },
  "uml-interface": { stereotype: "interface", sections: ["attributes", "operations"] },
  "uml-enum": { stereotype: "enumeration", sections: ["literals"] },
  "uml-object": { nameStyle: "underline", sections: ["attributes"] },
  "uml-datatype": { stereotype: "datatype", sections: ["attributes"] },
  "db-table": { sections: ["columns"] },
  "db-view": { stereotype: "view", sections: ["columns"] },
  "db-junction": { stereotype: "junction", sections: ["columns"] },
};

// The structured shapes, with what each is for.
export const structuredItems: { kind: StructuredKind; label: string; description: string }[] = [
  { kind: "uml-class", label: "Class", description: "A class: its attributes and operations" },
  { kind: "uml-abstract", label: "Abstract class", description: "A class made only through its subclasses (name in italics)" },
  { kind: "uml-interface", label: "Interface", description: "What a class promises: operations without a body" },
  { kind: "uml-enum", label: "Enumeration", description: "A fixed set of named values" },
  { kind: "uml-object", label: "Object", description: "One instance of a class, with its values" },
  { kind: "uml-datatype", label: "Data type", description: "A value: equal when its values are equal" },
  { kind: "db-table", label: "Table", description: "A table with its columns, types and keys" },
  { kind: "db-view", label: "View", description: "A stored query that reads like a table" },
  { kind: "db-junction", label: "Junction table", description: "Links two tables many to many: a key from each" },
];
export const structureOf = (kind: ShapeKind): Structure | undefined => structures[kind as StructuredKind];

const isTable = (kind: ShapeKind) => kind.startsWith("db-");

// Key marks a column can have, as typed (any case) and as shown.
const tableMarks: [string, RegExp][] = [["pk", /^pk$/i], ["fk", /^fk$/i], ["uq", /^(uq|unique)$/i], ["nn", /^nn$/i]];
export const markLabel = (mark: string) => mark.toUpperCase();

export type RowFields = Omit<DiagramRow, "id" | "shapeId" | "z">;

// What was typed in a row, as fields. In a class: an operation when it has parentheses, else an attribute; in an
// enumeration a literal; in an object a slot ("name = value"); in a table a column with its keys.
export function parseRow(text: string, kind: ShapeKind, section?: RowSection): RowFields {
  const empty: RowFields = { section: section ?? structureOf(kind)?.sections[0] ?? "attributes", name: "", type: "", params: "", value: "", visibility: "", marks: [] };
  let rest = text.trim();
  if (isTable(kind)) {
    rest = rest.replace(/\bnot\s+null\b/gi, "NN");
    const words = rest.split(/\s+/).filter(Boolean);
    const marks: string[] = [];
    const kept = words.filter((word) => {
      const mark = tableMarks.find(([, pattern]) => pattern.test(word));
      if (mark && !marks.includes(mark[0])) marks.push(mark[0]);
      return !mark;
    });
    const joined = kept.join(" ");
    const colon = joined.indexOf(":");
    const [name, type] = colon >= 0 ? [joined.slice(0, colon), joined.slice(colon + 1)] : [kept[0] ?? "", kept.slice(1).join(" ")];
    return { ...empty, section: "columns", name: name.trim(), type: type.trim(), marks };
  }
  if (kind === "uml-enum") return { ...empty, section: "literals", name: rest };
  const marks: string[] = [];
  rest = rest.replace(/\{(static|abstract)\}/gi, (_, mark: string) => {
    marks.push(mark.toLowerCase());
    return "";
  }).replace(/\s+/g, " ").trim();
  let visibility: RowFields["visibility"] = "";
  if (/^[+\-#~]/.test(rest)) {
    visibility = rest[0] as RowFields["visibility"];
    rest = rest.slice(1).trim();
  }
  const open = rest.indexOf("(");
  const close = rest.lastIndexOf(")");
  if (kind !== "uml-object" && open > 0 && close > open) {
    const type = rest.slice(close + 1).trim().replace(/^:\s*/, "");
    return { ...empty, section: "operations", visibility, marks, name: rest.slice(0, open).trim(), params: rest.slice(open + 1, close).trim(), type };
  }
  const equals = rest.indexOf("=");
  const value = equals >= 0 ? rest.slice(equals + 1).trim() : "";
  const declared = equals >= 0 ? rest.slice(0, equals).trim() : rest;
  const colon = declared.indexOf(":");
  const name = (colon >= 0 ? declared.slice(0, colon) : declared).trim();
  const type = colon >= 0 ? declared.slice(colon + 1).trim() : "";
  return { ...empty, section: "attributes", visibility, marks, name, type, value };
}

// A row as it is typed: what the row's input starts with, and (without a table's keys, shown as marks beside it) what
// the shape shows.
export function rowText(row: RowFields, kind: ShapeKind, options: { marks?: boolean } = {}): string {
  if (isTable(kind)) {
    const keys = options.marks === false ? [] : row.marks.filter((mark) => tableMarks.some(([name]) => name === mark)).map(markLabel);
    return [row.name, row.type, ...keys].filter(Boolean).join(" ");
  }
  if (row.section === "literals") return row.name;
  const lead = [row.visibility, ...row.marks.filter((mark) => mark === "static").map(() => "{static}")].filter(Boolean).join(" ");
  const tail = row.marks.includes("abstract") ? " {abstract}" : "";
  const typed = row.type ? `: ${row.type}` : "";
  const body = row.section === "operations"
    ? `${row.name}(${row.params})${typed}`
    : `${row.name}${typed}${row.value ? ` = ${row.value}` : ""}`;
  return `${lead ? `${lead} ` : ""}${body}${tail}`;
}

// How a structured shape is drawn: its header, then a compartment per section (an empty one stays, thin), each row a
// line. `needed`: the height its rows take; `height`: what it is drawn at (never shorter than it was made).
export const rowHeight = 22;
const headerHeight = 30;
const stereotypeHeight = 16;
const compartmentPad = 4;
const emptyCompartment = 12;

export interface StructureLayout {
  header: { y: number; h: number };
  compartments: { section: RowSection; y: number; h: number; rows: { row: DiagramRow; y: number; h: number }[] }[];
  needed: number;
  height: number;
}

export function structureLayout(shape: DiagramShape, rows: readonly DiagramRow[]): StructureLayout {
  const structure = structureOf(shape.kind) ?? { sections: ["attributes"] as RowSection[] };
  const header = { y: 0, h: headerHeight + (structure.stereotype ? stereotypeHeight : 0) };
  let y = header.h;
  const compartments = structure.sections.map((section) => {
    const inSection = rows.filter((row) => row.section === section).sort((a, b) => a.z - b.z || a.id - b.id);
    const top = y;
    const placed = inSection.map((row, index) => ({ row, y: top + compartmentPad + index * rowHeight, h: rowHeight }));
    const h = inSection.length ? inSection.length * rowHeight + compartmentPad * 2 : emptyCompartment;
    y += h;
    return { section, y: top, h, rows: placed };
  });
  return { header, compartments, needed: y, height: Math.max(y, shape.h) };
}

// Where a new row of this section goes in its order: after the given row, or last.
export function rowZ(rows: readonly DiagramRow[], section: RowSection, after?: DiagramRow): number {
  const inSection = rows.filter((row) => row.section === section).sort((a, b) => a.z - b.z);
  if (!after) return (inSection.at(-1)?.z ?? 0) + 1;
  const next = inSection.find((row) => row.z > after.z);
  return next ? (after.z + next.z) / 2 : after.z + 1;
}
