// Errors and warnings: the open file's (built-in checks and its language server) and every other file a language
// server reported on. A click opens the file at that line.
import { For, Show } from "solid-js";
import { Icon } from "../../../theme/icons";
import type { CodeFile } from "./data";
import type { Problem } from "./editor";

export default function ProblemsPanel(props: {
  problems: () => { file: CodeFile | undefined; path: string; problems: Problem[] }[];
  onOpen: (file: CodeFile, line: number, column: number) => void;
  note: () => string;
  // A missing language server the app can download.
  install: () => { from: string; busy: boolean } | null;
  onInstall: () => void;
}) {
  const total = () => props.problems().reduce((sum, group) => sum + group.problems.length, 0);
  return (
    <div class="code-find">
      <Show when={props.note()}><p class="code-find-note">{props.note()}</p></Show>
      <Show when={props.install()}>{(install) =>
        <div class="code-find-note code-install">
          <button class="mw-button mw-box" disabled={install().busy} onClick={props.onInstall}>
            <Show when={install().busy} fallback={<Icon name="download" size={14} />}><span class="mw-spinner" /></Show>
            <span>{install().busy ? "Installing..." : "Install it for me"}</span>
          </button>
          <span>Downloads {install().from} into the app's own folder.</span>
        </div>
      }</Show>
      <div class="code-find-results mw-scroll-fade">
        <For each={props.problems()}>{(group) =>
          <>
            <div class="code-find-file code-problem-file"><Icon name="code-file" size={14} /><span>{group.path}</span></div>
            <For each={group.problems}>{(problem) =>
              <button class="code-find-hit code-problem" disabled={!group.file} onClick={() => group.file && props.onOpen(group.file, problem.line, problem.column)}>
                <span class="code-problem-line">
                  <Icon name={problem.severity === "error" ? "error" : problem.severity === "warning" ? "warning" : "info"} size={14} />
                  <span class={`code-problem-text ${problem.severity}`}>{problem.message}</span>
                </span>
                <span class="code-problem-where">{problem.source ? `${problem.source} · ` : ""}Ln {problem.line}, Col {problem.column}</span>
              </button>
            }</For>
          </>
        }</For>
        <Show when={!total()}><p class="code-find-note">No problems found.</p></Show>
      </div>
    </div>
  );
}
