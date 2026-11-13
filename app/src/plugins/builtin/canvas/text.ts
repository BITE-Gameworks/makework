// Text laid out for SVG exports, which can't wrap text themselves. Measured in the exports' font (sans-serif).
let measureContext: CanvasRenderingContext2D | null | undefined;

// The width of text in the export's font; an estimate where there is no canvas (tests, headless).
function textWidth(text: string, fontSize: number): number {
  if (measureContext === undefined) measureContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * fontSize * 0.55;
  measureContext.font = `${fontSize}px sans-serif`;
  return measureContext.measureText(text).width;
}

// Text as a box in the app shows it: its own line breaks kept, and lines wrapped at words to the width (long words
// broken where they must be).
export function wrapText(text: string, fontSize: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(?<=\s)/)) {
      if (line && textWidth(line + word.trimEnd(), fontSize) > width) {
        lines.push(line.trimEnd());
        line = "";
      }
      line += word;
      // A word longer than the width goes over several lines.
      while (line.trimEnd().length > 1 && textWidth(line.trimEnd(), fontSize) > width) {
        let cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), fontSize) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// One line cut to the width, ending in "…" when it had to be (a row of a class or table).
export function fitText(text: string, fontSize: number, width: number): string {
  if (textWidth(text, fontSize) <= width) return text;
  let end = text.length;
  while (end > 0 && textWidth(`${text.slice(0, end)}…`, fontSize) > width) end--;
  return end > 0 ? `${text.slice(0, end)}…` : "";
}
