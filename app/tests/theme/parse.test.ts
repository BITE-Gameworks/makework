import { describe, expect, it } from "vitest";
import { parseTheme, ThemeError } from "../../src/theme/parse";
import { builtInThemes } from "../../src/theme/store";
import { themeVariables } from "../../src/theme/apply";

const base = builtInThemes[0];

function problems(file: object): string[] {
  try {
    parseTheme({ id: "t", name: "T", ...file }, base);
    return [];
  } catch (e) {
    return (e as ThemeError).problems;
  }
}

describe("parseTheme", () => {
  it("keeps a saved theme from before heading fonts", () => {
    const { heading: _heading, ...fonts } = builtInThemes[0].fonts;
    const saved = { ...builtInThemes[0], fonts };
    expect(parseTheme(saved, undefined).fonts.heading).toBeUndefined();
    expect(() => parseTheme({ ...saved, fonts: { ...fonts, heading: "url(x)" } }, undefined)).toThrow(ThemeError);
  });

  it("resolves the built-in themes", () => {
    expect(builtInThemes.map((t) => t.id)).toEqual(["makework-dark", "makework-light", "makework-oled", "makework-nier", "makework-cyber", "makework-frostfall", "makework-contra"]);
    expect(builtInThemes[2].layout).toEqual({ ...base.layout, gap: 6, margin: 16 });
    expect(builtInThemes[4].shape.corners).toBe("cut");
  });

  it("merges a partial theme over its base", () => {
    const theme = parseTheme({ id: "t", name: "T", colors: { accent: "#123456" } }, base);
    expect(theme.colors.accent).toBe("#123456");
    expect(theme.colors.dark).toBe(base.colors.dark);
  });

  it("rejects unsafe or out of range values", () => {
    expect(problems({ colors: { accent: "red; background: url(x)" } })).toHaveLength(1);
    expect(problems({ shadow: { panel: "0 0 url(https://x)" } })).toHaveLength(1);
    expect(problems({ fonts: { ui: "x} body{display:none" } })).toHaveLength(1);
    expect(problems({ layout: { gap: 999 } })).toHaveLength(1);
    expect(problems({ layout: { margin: 60 } })).toHaveLength(1);
    expect(problems({ icons: { overrides: { mic: "https://x/mic.svg" } } })).toHaveLength(1);
    expect(problems({ sounds: { message: 'data:audio/wav,")' } })).toHaveLength(1);
    expect(problems({ id: "Bad Id" })).toHaveLength(1);
  });

  it("gives every view the theme's margin to snap to", () => {
    expect(base.layout.margin).toBe(12);
    expect(themeVariables(parseTheme({ id: "t", name: "T", layout: { margin: 24 } }, base))["--mw-margin"]).toBe("24px");
  });
});
