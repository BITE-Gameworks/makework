// A diff shown file by file: status, path, +/- counts, and the lines with both sides' numbers. Big files start folded.
import { For, Show, createMemo, createSignal } from "solid-js";
import { highlight } from "../../../markdown/highlight";
import { Icon } from "../../../theme/icons";
import type { DiffFile, DiffLine } from "./diff";

// Files with more lines than this start folded, and lines past the cap aren't highlighted (both keep big diffs fast).
const foldOver = 400;
const highlightUpTo = 4000;

const statusLabel: Record<DiffFile["status"], string> = { added: "A", deleted: "D", modified: "M", renamed: "R" };

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
}) {
  const totals = createMemo(() => props.files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }));
  return (
    <div class="git-diff">
      <Show when={props.files.length} fallback={<p class="view-note">{props.empty ?? "No changes."}</p>}>
        <p class="git-diff-summary muted">
          {props.files.length} {props.files.length === 1 ? "file" : "files"} changed · <DiffStats additions={totals().add} deletions={totals().del} />
        </p>
        <For each={props.files}>{(file) => <DiffFileView file={file} onBlame={props.onBlame} />}</For>
      </Show>
      <Show when={props.truncated}>
        <p class="view-note warning">This diff is too large to show completely; some files or lines are missing.</p>
      </Show>
    </div>
  );
}

function DiffFileView(props: { file: DiffFile; onBlame?: (path: string) => void }) {
  const f = () => props.file;
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
            <DiffLines lines={f().lines} />
          </Show>
        </Show>
      </Show>
      <Show when={!open() && !f().binary && f().lines.length > foldOver}>
        <button class="mw-button mw-box git-diff-unfold" onClick={() => setOpen(true)}>Show {f().lines.length.toLocaleString()} lines</button>
      </Show>
    </section>
  );
}

export function DiffLines(props: { lines: DiffLine[] }) {
  return (
    <div class="git-diff-lines">
      <For each={props.lines}>
        {(line, i) => (
          <div class={`git-diff-line ${line.kind}`}>
            <span class="git-diff-no">{line.oldNo ?? ""}</span>
            <span class="git-diff-no">{line.newNo ?? ""}</span>
            <span class="git-diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span>
            <code>
              <Show when={line.kind !== "hunk" && line.kind !== "note" && i() < highlightUpTo} fallback={line.text}>
                <For each={highlight(line.text)}>{(t) => (t.kind === "plain" ? t.text : <span class={`tok-${t.kind}`}>{t.text}</span>)}</For>
              </Show>
            </code>
          </div>
        )}
      </For>
    </div>
  );
}
