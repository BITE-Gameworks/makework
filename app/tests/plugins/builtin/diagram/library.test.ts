import { describe, expect, it } from "vitest";
import { libraryItems } from "../../../../src/plugins/builtin/diagram/library";

// The diagram's library on the left: shapes and connector kinds in sections, each with its icon and a line on what it
// is for; search looks at both.
describe("the diagram library", () => {
  it("lists shapes, flow, UML and ER connectors in their own sections, each item with a description", () => {
    const sections = libraryItems("");
    expect(sections.map((section) => section.id)).toEqual(["shapes", "flow", "uml-classes", "database"]);
    for (const section of sections) {
      expect(section.icon).toBeTruthy();
      for (const item of section.items) {
        expect(item.icon).toBeTruthy();
        expect(item.description.length).toBeGreaterThan(5);
      }
    }
    // A diagram type's section has its shapes first, then its connector kinds.
    const uml = sections.find((section) => section.id === "uml-classes")!;
    expect(uml.items.map((item) => item.type === "connector" ? item.preset.id : item.kind)).toEqual(expect.arrayContaining(["uml-class", "uml-interface", "uml-enum", "composition"]));
    expect(uml.items[0].type).toBe("shape");
    const database = sections.find((section) => section.id === "database")!;
    expect(database.items.map((item) => item.type === "connector" ? item.preset.id : item.kind)).toEqual(expect.arrayContaining(["db-table", "db-view", "one-to-many"]));
    // Every item its own picture.
    const icons = sections.flatMap((section) => section.items.map((item) => item.icon));
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("finds items by what they mean, and leaves out sections with nothing found", () => {
    const sections = libraryItems("inherit");
    expect(sections.map((section) => section.id)).toEqual(["uml-classes"]);
    expect(sections[0].items.map((item) => item.label)).toEqual(["Generalization"]);
    expect(libraryItems("decision")[0].items.map((item) => item.label)).toContain("Decision");
    expect(libraryItems("nothing like this")).toEqual([]);
  });
});
