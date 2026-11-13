// Blame: who last changed each line of a file at a commit, in runs of lines from the same commit. Read from the
// folder on this device; clicking a run shows that commit.
import { For, Show, createMemo, createResource } from "solid-js";
import { userMessage } from "../../../api/client";
import { desktop, desktopError, type GitBlameLine } from "../../../core/desktop";
import { relativeTime } from "../../../core/time";
import { highlight } from "../../../markdown/highlight";

interface Run {
  sha: string;
  author: string;
  time: number;
  summary: string;
  lines: GitBlameLine[];
}

export default function BlameView(props: { folder: string; rev: string; path: string; onCommit: (sha: string) => void }) {
  const [lines] = createResource(() => [props.folder, props.rev, props.path] as const,
    ([folder, rev, path]) => desktop!.git!.blame(folder, rev, path).catch((e) => { throw desktopError(e); }));
  const runs = createMemo(() => {
    const out: Run[] = [];
    for (const line of lines() ?? []) {
      const last = out.at(-1);
      if (last?.sha === line.sha) last.lines.push(line);
      else out.push({ sha: line.sha, author: line.author, time: line.time, summary: line.summary, lines: [line] });
    }
    return out;
  });

  return (
    <div class="git-blame">
      <p class="git-diff-summary muted"><code>{props.path}</code> at <code>{props.rev.slice(0, 12)}</code></p>
      <Show when={!lines.error} fallback={<p class="view-error">{userMessage(lines.error)}</p>}>
        <Show when={!lines.loading} fallback={<p class="view-note">Reading who wrote what...</p>}>
          <div class="git-blame-lines">
            <For each={runs()}>
              {(run) => (
                <div class="git-blame-run">
                  <button class="git-blame-who" title={`${run.summary}\n${run.author}, ${new Date(run.time).toLocaleString()}`}
                    onClick={() => props.onCommit(run.sha)}>
                    <code>{run.sha.slice(0, 7)}</code>
                    <span class="git-blame-author">{run.author}</span>
                    <span class="muted">{relativeTime(new Date(run.time).toISOString())}</span>
                  </button>
                  <div class="git-blame-code">
                    <For each={run.lines}>
                      {(line) => (
                        <div class="git-diff-line context">
                          <span class="git-diff-no">{line.line}</span>
                          <code>
                            <For each={highlight(line.text)}>{(t) => (t.kind === "plain" ? t.text : <span class={`tok-${t.kind}`}>{t.text}</span>)}</For>
                          </code>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
