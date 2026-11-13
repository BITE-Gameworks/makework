// The diagram's library on the left: the shapes and the connector kinds, in sections, each item with its icon and a
// line on what it is for. Search looks at names and descriptions.
import { connectorIcon, presets, type Preset } from "./ends";
import { shapeKinds, type ShapeKind, type StructuredKind } from "./model";
import { structuredItems } from "./rows";

export type LibraryItem =
  | { type: "shape"; kind: ShapeKind; label: string; description: string; icon: string }
  | { type: "connector"; preset: Preset; label: string; description: string; icon: string };

export interface LibrarySection {
  id: "shapes" | "flow" | "uml-classes" | "database";
  title: string;
  icon: string;
  items: LibraryItem[];
}

// A structured shape's picture: a box with its header and rows, and what tells the kinds apart (an "I" for an interface,
// a key column for a table ...). Drawn as a mask in the text color, like every icon.
function boxIcon(kind: StructuredKind): string {
  const table = kind.startsWith("db-");
  const mark: Partial<Record<StructuredKind, string>> = {
    "uml-abstract": '<text x="12" y="8.2" font-size="6" font-style="italic" font-family="serif" text-anchor="middle">A</text>',
    "uml-interface": '<text x="12" y="8.2" font-size="6" font-family="sans-serif" text-anchor="middle">I</text>',
    "uml-enum": '<path d="M 6 11.5 h1 M 6 15 h1 M 6 18.5 h1" stroke-width="2"/>',
    "uml-object": '<path d="M 8 8 H 16"/>',
    "uml-datatype": '<text x="12" y="8.2" font-size="6" font-family="sans-serif" text-anchor="middle">T</text>',
    "db-view": '<path d="M 3 3 H 21" stroke-dasharray="2 1.5"/>',
    "db-junction": '<path d="M 0.5 12 H 3 M 21 12 H 23.5"/>',
  };
  const rows = table ? '<path d="M 3 10 H 21 M 3 14.5 H 21 M 3 18 H 21 M 8 10 V 21"/>' : '<path d="M 3 10 H 21 M 3 15 H 21"/><path d="M 6 12.5 h8 M 6 18 h10" stroke-width="1.2"/>';
  const outline = kind === "db-view"
    ? '<rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="2 1.5"/>' : '<rect x="3" y="3" width="18" height="18" rx="1"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.6">${outline}${rows}${mark[kind] ?? ""}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg.replaceAll("<text ",'<text fill="black" stroke="none" '))}`;
}

const structured = (prefix: "uml-" | "db-"): LibraryItem[] => structuredItems.filter((item) => item.kind.startsWith(prefix))
  .map((item) => ({ type: "shape", ...item, icon: boxIcon(item.kind) }));

const kindIcon = (preset: Preset) => connectorIcon(preset.start, preset.end, preset.dash);
const connectors = (group: Preset["group"]): LibraryItem[] => presets.filter((preset) => preset.group === group)
  .map((preset) => ({ type: "connector", preset, label: preset.label, description: preset.description, icon: kindIcon(preset) }));
const preset = (id: string) => presets.find((item) => item.id === id)!;

const sections: LibrarySection[] = [
  { id: "shapes", title: "Shapes", icon: "diagram-rect", items: shapeKinds.map((item) => ({ type: "shape", ...item })) },
  { id: "flow", title: "Flow", icon: kindIcon(preset("flow")), items: connectors("flow") },
  { id: "uml-classes", title: "UML classes", icon: boxIcon("uml-class"), items: [...structured("uml-"), ...connectors("uml")] },
  { id: "database", title: "Database tables", icon: boxIcon("db-table"), items: [...structured("db-"), ...connectors("er")] },
];

// The sections with the items matching the search; sections with none left out.
export function libraryItems(query: string): LibrarySection[] {
  const words = query.trim().toLowerCase();
  if (!words) return sections;
  const matches = (item: LibraryItem) => `${item.label} ${item.description}`.toLowerCase().includes(words);
  return sections.map((section) => ({ ...section, items: section.items.filter(matches) })).filter((section) => section.items.length > 0);
}
