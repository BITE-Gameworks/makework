// Fetch, Pull and Push for the checked-out branch, with how far it is behind and ahead of origin. Each button acts at
// once (all checks in electron/gitOps.js); what happened shows in the status line, and the push panel opens when a
// push needs a decision (the remote has new commits, a big deletion to confirm).
import { Show } from "solid-js";
import { Icon } from "../../../theme/icons";
import { pullMessage, pushMessage } from "./actions";
import { describeChanges } from "./watch";
import type { WorkingCopy } from "./workingCopy";
import { gitCall } from "./local";

export default function SyncBar(props: { wc: WorkingCopy; onChanged: () => void; onAttention: () => void; onStashes: () => void }) {
  const wc = props.wc;
  const current = () => wc.current();
  const behind = () => current()?.behind ?? 0;
  const ahead = () => current()?.ahead ?? 0;
  const published = () => !!current()?.upstream;

  const fetchNow = () => void wc.act("Fetching", (f) => gitCall((git) => git.fetch(f)), (changes) => {
    const moved = changes.filter((c) => c.count > 0);
    return moved.length
      ? { kind: "ok", text: `Fetched: ${describeChanges(moved.map((c) => ({ branch: c.branch, count: c.count, isNew: c.from === null })))}.` }
      : { kind: "info", text: "No new commits on the remote." };
  });
  const pull = () => void wc.act("Pulling", (f) => gitCall((git) => git.merge(f)), (r) => {
    if (r.ok) props.onChanged();
    return pullMessage(r);
  });
  const push = () => void wc.act("Pushing", (f) => gitCall((git) => git.push(f)), (r) => {
    if (r.ok) props.onChanged();
    const message = pushMessage(r);
    if (message.attention) props.onAttention();
    return message;
  });

  return (
    <div class="git-sync mw-box" aria-label="Sync with the remote">
      <span class="git-sync-branch" title="The branch checked out here">
        <Icon name="channel-git" />{wc.branches()?.current ?? "no branch"}
      </span>
      <Show when={wc.stashes().length}>
        <button class="mw-button mw-box git-sync-stashes mw-fade-in" onClick={props.onStashes}
          title={`${wc.stashes().length} stashed ${wc.stashes().length === 1 ? "change" : "changes"} (open Changes to restore)`}
          aria-label={`${wc.stashes().length} ${wc.stashes().length === 1 ? "stash" : "stashes"}`}>
          <Icon name="box" /><span class="git-sync-stash-count">{wc.stashes().length}</span>
        </button>
      </Show>
      <button class="mw-button mw-box" disabled={!!wc.busy()} onClick={fetchNow} title="Look for new commits on the remote (changes nothing here)">
        <Icon name="refresh" /> {wc.busy() === "Fetching" ? "Fetching..." : "Fetch"}
      </button>
      <button class="mw-button mw-box" disabled={!!wc.busy() || !published() || behind() === 0} onClick={pull}
        title={behind() ? `Bring in ${behind()} new commits from origin (only when it can't conflict)` : "Nothing new on the remote"}>
        <Icon name="download" /> {wc.busy() === "Pulling" ? "Pulling..." : "Pull"}<Show when={behind()}> {behind()}</Show>
      </button>
      <Show when={published() || !current()} fallback={
        <button class="mw-button mw-box accent" disabled={!!wc.busy()} onClick={push} title="Create this branch on the remote">
          <Icon name="upload" /> {wc.busy() === "Pushing" ? "Publishing..." : "Publish"}
        </button>
      }>
        <button class="mw-button mw-box" classList={{ accent: ahead() > 0 }} disabled={!!wc.busy() || ahead() === 0} onClick={push}
          title={ahead() ? `Send ${ahead()} commits to origin (never forced)` : "Nothing to push"}>
          <Icon name="upload" /> {wc.busy() === "Pushing" ? "Pushing..." : "Push"}<Show when={ahead()}> {ahead()}</Show>
        </button>
      </Show>
    </div>
  );
}
