// A diff shown file by file: status, path, +/- counts, and the lines with both sides' numbers. Big files start folded.
// With `picking`, changed lines can be ticked (each, or a hunk's at once) and the ticked ones are marked.
import { For, Show, createMemo, createSignal } from "solid-js";
import { highlight } from "../../../markdown/highlight";
import { Icon } from "../../../theme/icons";
import type { DiffFile, DiffLine } from "./diff";

// Files with more lines than this start folded, and lines past the cap aren't highlighted (both keep big diffs fast).
const foldOver = 400;
const highlightUpTo = 4000;

const statusLabel: Record<DiffFile["status"], string> = { added: "A", deleted: "D", modified: "M", renamed: "R" };

// Picking changed lines of a diff (to discard them): which files allow it, which lines are picked, and picking.
export interface LinePicking {
  can(file: DiffFile): boolean;
  has(file: DiffFile, line: number): boolean;
  // Picks the lines, or unpicks them when every one is picked already.
  toggle(file: DiffFile, lines: number[]): void;
  // What a line's checkbox says it does.
  label: string;
}

// One file's picking, as `DiffLines` takes it.
export interface LinesPick {
  has(line: number): boolean;
  toggle(lines: number[]): void;
  label: string;
}

export function DiffStats(props: { additions: number; deletions: number }) {
  return (
    <span class="git-diff-stats">
      <span class="git-add-count">+{props.additions}</span> <span class="git-del-count">−{props.deletions}</span>
    </span>
  );
}

export default function DiffView(props: {
  files: DiffFile[];
  truncated?: boolean;
  // Offered per file when there is a folder on this device to read it from.
  onBlame?: (path: string) => void;
  empty?: string;
  picking?: LinePicking;
}) {
  const totals = createMemo(() => props.files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }));
  return (
    <div class="git-diff">
      <Show when={props.files.length} fallback={<p class="view-note">{props.empty ?? "No changes."}</p>}>
        <p class="git-diff-summary muted">
          {props.files.length} {props.files.length === 1 ? "file" : "files"} changed · <DiffStats additions={totals().add} deletions={totals().del} />
        </p>
        <For each={props.files}>{(file) => <DiffFileView file={file} onBlame={props.onBlame} picking={props.picking} />}</For>
      </Show>
      <Show when={props.truncated}>
        <p class="view-note warning">This diff is too large to show completely; some files or lines are missing.</p>
      </Show>
    </div>
  );
}

function DiffFileView(props: { file: DiffFile; onBlame?: (path: string) => void; picking?: LinePicking }) {
  const f = () => props.file;
  const pick = (): LinesPick | undefined => {
    const picking = props.picking;
    if (!picking?.can(f())) return undefined;
    return { has: (line) => picking.has(f(), line), toggle: (lines) => picking.toggle(f(), lines), label: picking.label };
  };
  const [open, setOpen] = createSignal(props.file.lines.length <= foldOver);
  const name = () => (f().status === "renamed" && f().oldPath ? `${f().oldPath} → ${f().path}` : f().path);
  return (
    <section class="git-diff-file mw-box">
      <header class="git-diff-file-head">
        <button class="git-diff-toggle" aria-expanded={open()} onClick={() => setOpen(!open())} title={name()}>
          <Icon name={open() ? "expanded" : "collapsed"} />
          <span class={`git-status git-status-${f().status}`} title={f().status}>{statusLabel[f().status]}</span>
          <span class="git-diff-path">{name()}</span>
        </button>
        <DiffStats additions={f().additions} deletions={f().deletions} />
        <Show when={props.onBlame && f().status !== "deleted" && !f().binary}>
          <button class="icon-button" title="Blame: who wrote each line" aria-label={`Blame ${f().path}`} onClick={() => props.onBlame!(f().path)}>
            <Icon name="history" />
          </button>
        </Show>
      </header>
      <Show when={open()}>
        <Show when={!f().binary} fallback={<p class="view-note">Binary file, not shown.</p>}>
          <Show when={f().lines.length} fallback={<p class="view-note">{f().status === "renamed" ? "Renamed without changes." : "No line changes."}</p>}>
            <DiffLines lines={f().lines} pick={pick()} />
          </Show>
        </Show>
      </Show>
      <Show when={!open() && !f().binary && f().lines.length > foldOver}>
        <button class="mw-button mw-box git-diff-unfold" onClick={() => setOpen(true)}>Show {f().lines.length.toLocaleString()} lines</button>
      </Show>
    </section>
  );
}

export function DiffLines(props: { lines: DiffLine[]; pick?: LinesPick }) {
  return (
    <Show when={props.pick} fallback={
      <div class="git-diff-lines">
        <For each={props.lines}>{(line, i) => <div class={`git-diff-line ${line.kind}`}><LineCells line={line} index={i()} /></div>}</For>
      </div>
    }>
      {(pick) => <PickableLines lines={props.lines} pick={pick()} />}
    </Show>
  );
}

function LineCells(props: { line: DiffLine; index: number }) {
  const line = () => props.line;
  return (
    <>
      <span class="git-diff-no">{line().oldNo ?? ""}</span>
      <span class="git-diff-no">{line().newNo ?? ""}</span>
      <span class="git-diff-sign">{line().kind === "add" ? "+" : line().kind === "del" ? "−" : ""}</span>
      <code>
        <Show when={line().kind !== "hunk" && line().kind !== "note" && props.index < highlightUpTo} fallback={line().text}>
          <For each={highlight(line().text)}>{(t) => (t.kind === "plain" ? t.text : <span class={`tok-${t.kind}`}>{t.text}</span>)}</For>
        </Show>
      </code>
    </>
  );
}

// Lines with a checkbox on each change, and one on each hunk for all of its changes; picked changes are marked.
function PickableLines(props: { lines: DiffLine[]; pick: LinesPick }) {
  // Each hunk's changed lines, by the hunk line's index, once per lines.
  const blocks = createMemo(() => {
    const found = new Map<number, number[]>();
    let current: number[] = [];
    props.lines.forEach((line, i) => {
      if (line.kind === "hunk") found.set(i, (current = []));
      else if (line.kind === "add" || line.kind === "del") current.push(i);
    });
    return found;
  });
  const row = (line: DiffLine, i: number) => {
    if (line.kind === "add" || line.kind === "del") return (
      <label class={`git-diff-line ${line.kind}`} classList={{ picked: props.pick.has(i) }}>
        <input type="checkbox" class="git-diff-pick" checked={props.pick.has(i)} onChange={() => props.pick.toggle([i])}
          aria-label={props.pick.label} />
        <LineCells line={line} index={i} />
      </label>
    );
    const block = blocks().get(i);
    if (!block?.length) return <div class={`git-diff-line ${line.kind}`}><span /><LineCells line={line} index={i} /></div>;
    return (
      <div class="git-diff-line hunk">
        <input type="checkbox" class="git-diff-pick" checked={block.every((n) => props.pick.has(n))} onChange={() => props.pick.toggle(block)}
          title="Every change in this block" aria-label={`${props.pick.label}: every change in this block`} />
        <LineCells line={line} index={i} />
      </div>
    );
  };
  return (
    <div class="git-diff-lines picking">
      <For each={props.lines}>{(line, i) => row(line, i())}</For>
    </div>
  );
}
