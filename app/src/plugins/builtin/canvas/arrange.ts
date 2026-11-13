// Arranging and normalizing a selection, like BeeRef's Arrange and Normalize. Pure: boxes in, new places or
// sizes out.
export interface ArrangeBox {
  id: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Arrangement = "optimal" | "horizontal" | "vertical" | "grid";
export type Normalization = "height" | "width" | "size";

// Space between arranged boxes, in canvas units.
export const arrangeGap = 16;

// New top left corners, laid out from the selection's top left corner.
export function arrange(boxes: ArrangeBox[], how: Arrangement, gap = arrangeGap): Map<number, { left: number; top: number }> {
  const out = new Map<number, { left: number; top: number }>();
  if (boxes.length === 0) return out;
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const put = (box: ArrangeBox, x: number, y: number) => out.set(box.id, { left: x, top: y });
  // Reading order: rows by top, then left, so the result keeps roughly the order people put things in.
  const reading = [...boxes].sort((a, b) => a.top - b.top || a.left - b.left);

  if (how === "horizontal") {
    let x = left;
    for (const box of [...boxes].sort((a, b) => a.left - b.left)) {
      put(box, x, top);
      x += box.width + gap;
    }
  } else if (how === "vertical") {
    let y = top;
    for (const box of [...boxes].sort((a, b) => a.top - b.top)) {
      put(box, left, y);
      y += box.height + gap;
    }
  } else if (how === "grid") {
    const columns = Math.ceil(Math.sqrt(boxes.length));
    const cellW = Math.max(...boxes.map((b) => b.width));
    const cellH = Math.max(...boxes.map((b) => b.height));
    reading.forEach((box, i) => {
      put(box, left + (i % columns) * (cellW + gap) + (cellW - box.width) / 2,
        top + Math.floor(i / columns) * (cellH + gap) + (cellH - box.height) / 2);
    });
  } else {
    // Shelf packing (tallest first, rows filled left to right), tried at several row widths; the most compact
    // result that is about screen shaped wins.
    const order = [...boxes].sort((a, b) => b.height - a.height || a.id - b.id);
    const widest = Math.max(...order.map((b) => b.width));
    const total = order.reduce((sum, b) => sum + b.width + gap, 0);
    const candidates = new Set<number>([widest, total]);
    let running = 0;
    for (const b of order) candidates.add(Math.max(widest, (running += b.width + gap)));
    const shelves = (rowWidth: number) => {
      const spots: [ArrangeBox, number, number][] = [];
      let x = 0;
      let y = 0;
      let rowHeight = 0;
      let right = 0;
      for (const box of order) {
        if (x > 0 && x + box.width > rowWidth) {
          x = 0;
          y += rowHeight + gap;
          rowHeight = 0;
        }
        spots.push([box, x, y]);
        right = Math.max(right, x + box.width);
        x += box.width + gap;
        rowHeight = Math.max(rowHeight, box.height);
      }
      const height = y + rowHeight;
      const aspect = right / height / 1.6;
      return { spots, score: right * height * (1 + Math.abs(Math.log(aspect))) };
    };
    const tried = [...candidates].map(shelves);
    const best = tried.reduce((a, b) => (b.score < a.score ? b : a), tried[0]);
    for (const [box, x, y] of best.spots) put(box, left + x, top + y);
  }
  return out;
}

// How much to scale each box so they share a height, a width or an area: the average of theirs, so the selection
// keeps about the same overall size.
export function normalize(boxes: ArrangeBox[], what: Normalization): Map<number, number> {
  const out = new Map<number, number>();
  if (boxes.length === 0) return out;
  const measure = (b: ArrangeBox) => (what === "height" ? b.height : what === "width" ? b.width : Math.sqrt(b.width * b.height));
  const target = boxes.reduce((sum, b) => sum + measure(b), 0) / boxes.length;
  for (const b of boxes) {
    const current = measure(b);
    out.set(b.id, current > 0 ? target / current : 1);
  }
  return out;
}
