// A commit beside the history: message, id, author, parents, and its diff (read from this device's folder, else from
// the host with this member's token). `commit` is null for one that isn't loaded in the list (blame can name any).
import { copyText } from "../../../core/clipboard";
import { For, Show, createResource } from "solid-js";
import { userMessage } from "../../../api/client";
import { Icon } from "../../../theme/icons";
import type { ChannelContext } from "../../types";
import { readerHere, type Commit, type Repo } from "./data";
import type { CommitDiff } from "./diff";
import DiffView from "./DiffView";

export default function CommitPane(props: {
  context: ChannelContext;
  repo: Repo;
  // The host of the channel's main repository (see readerHere).
  mainHost: string | null;
  sha: string;
  commit: Commit | null;
  labels: string[];
  // Set when this device has the folder, which blame reads.
  folder: string | null;
  onParent: (sha: string) => void;
  onBlame: (path: string) => void;
  // Where the diff comes from (this computer's graph reads the working copy); else the host or a local channel's folder.
  diff?: (sha: string) => Promise<CommitDiff>;
}) {
  const ctx = props.context;
  const [diff] = createResource(() => props.sha, async (sha) => {
    if (props.diff) return props.diff(sha);
    const here = await readerHere(ctx.workspace.id, ctx.channel.id, props.repo, undefined, props.mainHost);
    if (!here) throw new Error("This history came from a folder on another member's device without a link, so its changes can't be read here.");
    return here.reader.diff(sha);
  });
  return (
    <div class="git-commit-pane">
      <Show when={props.commit} fallback={<p class="git-details-meta"><code>{props.sha}</code></p>}>
        {(c) => <CommitDetails commit={c()} labels={props.labels} onParent={props.onParent} />}
      </Show>
      <h4 class="git-pane-section">Changes</h4>
      <Show when={!diff.error} fallback={<p class="view-error">{userMessage(diff.error)}</p>}>
        <Show when={diff()} fallback={<p class="view-note">Reading the changes...</p>}>
          {(d) => <DiffView files={d().files} truncated={d().truncated} onBlame={props.folder ? props.onBlame : undefined}
            empty="This commit changes no files." />}
        </Show>
      </Show>
    </div>
  );
}

// Message, id, author and parents (which select that commit).
function CommitDetails(props: { commit: Commit; labels: string[]; onParent: (sha: string) => void }) {
  const c = () => props.commit;
  const subject = () => c().message.split("\n")[0];
  const body = () => c().message.split("\n").slice(1).join("\n").trim();
  return (
    <div class="git-details">
      <Show when={props.labels.length}>
        <p class="git-details-labels">
          <For each={props.labels}>{(name) => <span class="git-label mw-box git-c0">{name}</span>}</For>
        </p>
      </Show>
      <h3 class="git-details-subject">{subject()}</h3>
      <Show when={body()}><pre class="git-body-text">{body()}</pre></Show>
      <dl class="git-details-meta">
        <dt>Commit</dt>
        <dd>
          <code>{c().sha}</code>{" "}
          <button class="icon-button" title="Copy" aria-label="Copy commit id" onClick={() => void copyText(c().sha)}>
            <Icon name="copy" />
          </button>
        </dd>
        <dt>Author</dt>
        <dd>{c().authorName} &lt;{c().authorEmail}&gt;</dd>
        <dt>Date</dt>
        <dd>{new Date(c().authoredAt).toLocaleString()}</dd>
        <dt>{c().parents.length > 1 ? "Merge of" : "Parent"}</dt>
        <dd>
          <Show when={c().parents.length} fallback={<span class="muted">none, the first commit</span>}>
            <For each={c().parents}>
              {(p) => <button class="mw-button mw-box git-parent" onClick={() => props.onParent(p)}><code>{p.slice(0, 7)}</code></button>}
            </For>
          </Show>
        </dd>
      </dl>
    </div>
  );
}
