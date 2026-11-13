// Lays out a commit graph like `git log --graph`: each commit gets a lane (column), and each row knows which lines
// pass through it, so every row can be drawn on its own. Commits come newest first, never a parent before its
// children. A lane waits for the next commit of its line; free lanes are reused so the graph stays narrow.

export interface GraphCommit {
  sha: string;
  parents: string[];
}

// One line inside a row: from the top edge or the dot (mid) to the dot or the bottom edge, in lane columns.
export interface Line {
  from: number;
  to: number;
  part: "top" | "bottom";
  color: number;
  // Leads to a parent that isn't in the list (not imported yet): drawn fading out.
  fade?: boolean;
}

export interface GraphRow {
  lane: number;
  color: number;
  merge: boolean;
  lines: Line[];
}

export function layoutGraph(commits: GraphCommit[]): { rows: GraphRow[]; width: number } {
  const present = new Set(commits.map((c) => c.sha));
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  let width = 1;
  const free = (except = -1) => {
    const i = lanes.findIndex((sha, k) => sha === null && k !== except);
    return i >= 0 ? i : lanes.length;
  };

  const rows = commits.map((commit): GraphRow => {
    const lines: Line[] = [];
    const waiting = lanes.flatMap((sha, i) => (sha === commit.sha ? [i] : []));
    const lane = waiting[0] ?? free();
    if (waiting.length === 0) colors[lane] = nextColor++;
    const color = colors[lane];

    // Into the dot from above: this commit's lanes converge; other lines pass by.
    lanes.forEach((sha, i) => {
      if (sha === null) return;
      lines.push(sha === commit.sha ? { from: i, to: lane, part: "top", color: colors[i] } : { from: i, to: i, part: "top", color: colors[i] });
    });
    for (const i of waiting) lanes[i] = null;

    // Out of the dot: the first parent carries on in this lane, further parents (merges) join or open lanes.
    const [first, ...others] = commit.parents;
    lanes[lane] = null;
    const drawn = new Set<number>();
    if (first !== undefined) {
      if (present.has(first)) {
        lanes[lane] = first;
        lines.push({ from: lane, to: lane, part: "bottom", color });
      } else lines.push({ from: lane, to: lane, part: "bottom", color, fade: true });
      drawn.add(lane);
    }
    for (const parent of others) {
      if (!present.has(parent)) {
        lines.push({ from: lane, to: lane + 1, part: "bottom", color, fade: true });
        continue;
      }
      let target = lanes.indexOf(parent);
      if (target < 0) {
        target = free(lane);
        lanes[target] = parent;
        colors[target] = nextColor++;
        // A new lane starts here; an existing one keeps its own line through this row as well.
        drawn.add(target);
      }
      lines.push({ from: lane, to: target, part: "bottom", color: colors[target] });
    }
    // Everything else that waits below carries on.
    lanes.forEach((sha, i) => {
      if (sha !== null && !drawn.has(i)) lines.push({ from: i, to: i, part: "bottom", color: colors[i] });
    });
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    width = Math.max(width, lane + 1, ...lines.map((l) => Math.max(l.from, l.to) + 1));
    return { lane, color, merge: commit.parents.length > 1, lines };
  });
  return { rows, width };
}
