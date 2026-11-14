// Commits as graph rows: lanes, short id, branch labels, subject, author, date. Used by the shared history (the
// server's imported commits) and by this computer's graph (the working copy, with origin's branches and marks for
// commits that aren't here yet or aren't pushed).
import { For, Show, createMemo } from "solid-js";
import { relativeTime } from "../../../core/time";
import type { Commit } from "./data";
import { GraphCell, colorClass } from "./GitGraph";
import { layoutGraph } from "./graph";

export interface CommitLabel {
  name: string;
  // pinned: the commit a submodule's parent records for it.
  kind: "local" | "remote" | "tag" | "detached" | "pinned";
  // Checked out in this copy.
  head?: boolean;
  isDefault?: boolean;
}

export type CommitMark = "incoming" | "outgoing" | null;

export default function CommitList(props: {
  rows: Commit[];
  labelsOf: (sha: string) => CommitLabel[];
  markOf?: (sha: string) => CommitMark;
  selected: string | null;
  onSelect: (sha: string) => void;
  onRowMenu?: (event: MouseEvent, commit: Commit) => void;
  onLabelMenu?: (event: MouseEvent, label: CommitLabel) => void;
  ref?: (list: HTMLOListElement) => void;
}) {
  const graph = createMemo(() => layoutGraph(props.rows));
  return (
    <ol class="git-commit-list" ref={props.ref}>
      <For each={props.rows}>
        {(c, i) => {
          const row = () => graph().rows[i()];
          const mark = () => props.markOf?.(c.sha) ?? null;
          return (
            <li class="git-commit" classList={{ selected: props.selected === c.sha, incoming: mark() === "incoming" }} data-sha={c.sha}
              onContextMenu={props.onRowMenu && ((e) => { e.preventDefault(); props.onRowMenu!(e, c); })}>
              <button class="git-commit-line" onClick={() => props.onSelect(c.sha)} title={c.message}>
                <Show when={row()}>{(r) => <GraphCell row={r()} width={graph().width} />}</Show>
                <code class="git-sha">{c.sha.slice(0, 7)}</code>
                <span class="git-subject">
                  <For each={props.labelsOf(c.sha)}>
                    {(label) => (
                      <span class={`git-label mw-box ${colorClass(row()?.color ?? 0)}`}
                        classList={{ default: label.isDefault, remote: label.kind === "remote", tag: label.kind === "tag" || label.kind === "pinned", head: label.head }}
                        title={label.head ? `${label.name} (checked out here)` : label.kind === "pinned" ? "The commit its repository records for it" : label.name}
                        onContextMenu={props.onLabelMenu && ((e) => { e.preventDefault(); e.stopPropagation(); props.onLabelMenu!(e, label); })}>
                        {label.head ? "● " : ""}{label.name}
                      </span>
                    )}
                  </For>
                  <Show when={mark()}>
                    <span class="git-mark muted">{mark() === "incoming" ? "↓ not here yet" : "↑ not pushed"}</span>
                  </Show>
                  {c.message.split("\n")[0]}
                </span>
                <span class="git-author muted">{c.authorName}</span>
                <span class="git-date muted" title={new Date(c.authoredAt).toLocaleString()}>{relativeTime(c.authoredAt)}</span>
              </button>
            </li>
          );
        }}
      </For>
    </ol>
  );
}
