// The resizable pane beside a history: a commit with its diff, or blame of a file at a commit (blame needs the working
// copy on this device).
import { Match, Show, Switch, createSignal } from "solid-js";
import { readJson, writeJson } from "../../../core/storage";
import { Icon } from "../../../theme/icons";
import ResizeHandle from "../../../ui/ResizeHandle";
import type { ChannelContext } from "../../types";
import BlameView from "./BlameView";
import CommitPane from "./CommitPane";
import type { Commit, Repo } from "./data";
import type { CommitDiff } from "./diff";

export type Pane = { kind: "commit"; sha: string } | { kind: "blame"; rev: string; path: string };

const widthKey = "mw.git.paneWidth";
const defaultWidth = 560;
const minWidth = 320;

export default function CommitAside(props: {
  context: ChannelContext;
  repo: Repo;
  // The host of the channel's main repository (see readerHere).
  mainHost: string | null;
  pane: Pane;
  setPane: (pane: Pane | null) => void;
  folder: string | null;
  commitOf: (sha: string) => Commit | null;
  labelsOf: (sha: string) => string[];
  onSelect: (sha: string) => void;
  // Where the diff comes from; the host or this device's folder (see CommitPane) without it.
  diff?: (sha: string) => Promise<CommitDiff>;
}) {
  const [width, setWidth] = createSignal(readJson<number>(widthKey, defaultWidth));
  const commit = () => (props.pane.kind === "commit" ? props.pane : null);
  const blame = () => (props.pane.kind === "blame" && props.folder ? props.pane : null);
  const title = () => (props.pane.kind === "commit" ? `Commit ${props.pane.sha.slice(0, 7)}` : `Blame: ${props.pane.path.split("/").pop()}`);
  return (
    <aside class="git-pane mw-box mw-fade-in" style={{ width: `${width()}px` }} aria-label={title()}>
      <ResizeHandle edge="left" label="Resize the commit pane"
        setWidth={(w) => setWidth(w === null ? defaultWidth : Math.max(minWidth, Math.min(w, window.innerWidth * 0.75)))}
        save={() => writeJson(widthKey, width())} />
      <header class="git-pane-head">
        <Show when={props.pane.kind === "blame"}>
          <button class="icon-button" title="Back" aria-label="Back to the commit" onClick={() => {
            const p = props.pane;
            if (p.kind === "blame") props.setPane({ kind: "commit", sha: p.rev });
          }}><Icon name="back" /></button>
        </Show>
        <h3 class="git-pane-title">{title()}</h3>
        <button class="icon-button" title="Close" aria-label="Close" onClick={() => props.setPane(null)}><Icon name="close" /></button>
      </header>
      <div class="git-pane-body mw-scroll-fade">
        <Switch>
          <Match when={commit()}>
            {(c) => (
              <CommitPane context={props.context} repo={props.repo} mainHost={props.mainHost} sha={c().sha} folder={props.folder} diff={props.diff}
                commit={props.commitOf(c().sha)} labels={props.labelsOf(c().sha)}
                onParent={props.onSelect} onBlame={(path) => props.setPane({ kind: "blame", rev: c().sha, path })} />
            )}
          </Match>
          <Match when={blame()}>
            {(b) => <BlameView folder={props.folder!} rev={b().rev} path={b().path} onCommit={props.onSelect} />}
          </Match>
        </Switch>
      </div>
    </aside>
  );
}
