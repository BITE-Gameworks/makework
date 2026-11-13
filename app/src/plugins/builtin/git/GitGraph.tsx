import { For } from "solid-js";
import type { GraphRow, Line } from "./graph";

// Lane width and row height in px; rows in git.css have the same height.
export const laneWidth = 14;
export const rowHeight = 32;
const mid = rowHeight / 2;
const x = (lane: number) => lane * laneWidth + laneWidth / 2;

// A straight line, or a short curve where it changes lanes.
function path(line: Line): string {
  const [y1, y2] = line.part === "top" ? [0, mid] : [mid, rowHeight];
  const [x1, x2] = [x(line.from), x(line.to)];
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const bend = (y2 - y1) * 0.6;
  return `M${x1} ${y1}C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`;
}

export const colorClass = (color: number) => `git-c${color % 8}`;

// One row of the commit graph: the lines passing through and this commit's dot (a ring for merges).
export function GraphCell(props: { row: GraphRow; width: number }) {
  return (
    <svg class="git-graph" width={props.width * laneWidth} height={rowHeight} aria-hidden="true">
      <For each={props.row.lines}>
        {(line) => <path class={`git-line ${colorClass(line.color)}`} classList={{ fade: !!line.fade }} d={path(line)} />}
      </For>
      <circle class={`git-dot ${colorClass(props.row.color)}`} classList={{ merge: props.row.merge }}
        cx={x(props.row.lane)} cy={mid} r={props.row.merge ? 5 : 4} />
    </svg>
  );
}

