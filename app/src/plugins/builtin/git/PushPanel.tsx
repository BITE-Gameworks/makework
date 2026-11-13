// Pushing the current branch, safely: it fetches and checks first (electron/gitOps.js `pushCheck`) and says what a
// push would do. While the remote has commits this copy lacks, pushing is refused; they can be merged in when a dry
// run finds no conflicts, or after resolving them (MergeResolver). Nothing here ever forces.
import { For, Match, Show, Switch, createSignal, onMount } from "solid-js";
import { userMessage } from "../../../api/client";
import type { GitPushCheck } from "../../../core/desktop";
import { Icon } from "../../../theme/icons";
import { GitAuthError, commitLine, gitCall } from "./local";
import TypedConfirm from "./TypedConfirm";

export default function PushPanel(props: {
  folder: string;
  onChanged: () => void;
  onClose: () => void;
  // The remote needs a sign-in first; `retry` runs the same step again once signed in.
  onAuth: (e: GitAuthError, retry: () => void) => void;
  // Merging the remote's commits would conflict: resolve them first (the view opens the resolver).
  onResolve: () => void;
}) {
  const [check, setCheck] = createSignal<GitPushCheck | null>(null);
  const [busy, setBusy] = createSignal<"checking" | "pushing" | "merging" | null>(null);
  const [error, setError] = createSignal("");
  const [done, setDone] = createSignal("");
  const [confirmMass, setConfirmMass] = createSignal(false);
  // A sign-in the remote asked for goes to the view's sign-in prompt instead of an error here.
  const failed = (e: unknown, retry: () => void) => {
    if (e instanceof GitAuthError) props.onAuth(e, retry);
    else setError(userMessage(e));
  };

  const recheck = async () => {
    setBusy("checking");
    setError("");
    try {
      setCheck(await gitCall((git) => git.pushCheck(props.folder)));
    } catch (e) {
      setCheck(null);
      failed(e, () => void recheck());
    } finally {
      setBusy(null);
    }
  };
  onMount(() => void recheck());

  const push = async (allowMassDelete = false) => {
    setConfirmMass(false);
    setBusy("pushing");
    setError("");
    setDone("");
    try {
      const result = await gitCall((git) => git.push(props.folder, { allowMassDelete }));
      if (result.ok) {
        setDone(`Pushed ${result.pushed} ${result.pushed === 1 ? "commit" : "commits"} to ${result.branch}.`);
        props.onChanged();
      } else if (result.reason === "rejected") setError(`The remote refused the push, nothing was changed there: ${result.message}`);
      else if (result.reason === "mass-delete") setConfirmMass(true);
      if (!result.ok) setCheck(result.check);
      else await recheck();
    } catch (e) {
      failed(e, () => void push(allowMassDelete));
    } finally {
      setBusy(null);
    }
  };

  const merge = async () => {
    setBusy("merging");
    setError("");
    setDone("");
    try {
      const result = await gitCall((git) => git.merge(props.folder));
      if (result.ok) {
        setDone(result.fastForward ? `Brought in ${result.merged} new ${result.merged === 1 ? "commit" : "commits"} (fast-forward).`
          : `Merged ${result.merged} new ${result.merged === 1 ? "commit" : "commits"} into your branch.`);
        props.onChanged();
        await recheck();
      } else {
        if (result.reason === "failed") setError(`The merge didn't go through and was undone: ${result.message}`);
        setCheck(result.check);
      }
    } catch (e) {
      failed(e, () => void merge());
    } finally {
      setBusy(null);
    }
  };

  const c = () => check();
  return (
    <div class="git-push mw-box mw-fade-in">
      <header class="git-push-head">
        <h4>Push <Show when={c()}><code>{c()!.branch}</code></Show></h4>
        <button class="mw-button mw-box" disabled={!!busy()} onClick={() => void recheck()}><Icon name="refresh" /> Check again</button>
        <button class="icon-button" title="Close" aria-label="Close" onClick={props.onClose}><Icon name="close" /></button>
      </header>
      <Show when={busy()}><p class="view-note">{{ checking: "Fetching and checking...", pushing: "Pushing...", merging: "Merging..." }[busy()!]}</p></Show>
      <Show when={error()}><p class="view-error">{error()}</p></Show>
      <Show when={done()}><p class="hint git-note">{done()}</p></Show>
      <Show when={c() && !busy()}>
        <Show when={c()!.uncommitted.length}>
          <p class="hint">{c()!.uncommitted.length} uncommitted {c()!.uncommitted.length === 1 ? "change isn't" : "changes aren't"} part of a push; commit them first to include them.</p>
        </Show>
        <Switch>
          <Match when={c()!.state === "up-to-date"}><p class="view-note">Everything is pushed; the remote has nothing new.</p></Match>
          <Match when={c()!.state === "ahead" || c()!.state === "new-branch"}>
            <p>{c()!.state === "new-branch" ? `${c()!.branch} isn't on the remote yet. Pushing creates it with` : "Ready to push"}{" "}
              {c()!.ahead} {c()!.ahead === 1 ? "commit" : "commits"}:</p>
            <ul class="git-push-commits"><For each={c()!.outgoing}>{(o) => <li><code>{commitLine(o)}</code></li>}</For></ul>
            <Show when={c()!.blocked === "empty"} fallback={
              <button class="mw-button mw-box accent" onClick={() => void push()}>Push to origin/{c()!.branch}</button>
            }>
              <p class="view-error">Not pushed: this would leave the remote branch without any files.</p>
            </Show>
          </Match>
          <Match when={c()!.state === "behind" || c()!.state === "diverged"}>
            <p class="view-note warning">
              The remote has {c()!.behind} new {c()!.behind === 1 ? "commit" : "commits"} this copy doesn't have, so pushing would overwrite
              them and is not allowed.{c()!.ahead ? ` You have ${c()!.ahead} of your own to push after merging.` : ""}
            </p>
            <ul class="git-push-commits"><For each={c()!.incoming}>{(o) => <li><code>{commitLine(o)}</code></li>}</For></ul>
            <Switch>
              <Match when={c()!.merge?.clean}>
                <Show when={!c()!.uncommitted.length} fallback={<p class="hint">Commit your changes first, then merge.</p>}>
                  <button class="mw-button mw-box accent" onClick={() => void merge()}>
                    {c()!.ahead ? "Merge them (no conflicts)" : "Bring them in (fast-forward)"}
                  </button>
                </Show>
              </Match>
              <Match when={c()!.merge?.conflicts}>
                <p class="view-error">Merging would conflict in these files, so nothing was changed yet:</p>
                <ul class="git-push-commits"><For each={c()!.merge!.conflicts!}>{(f) => <li><code>{f}</code></li>}</For></ul>
                <button class="mw-button mw-box accent" onClick={() => props.onResolve()}>Resolve conflicts</button>
              </Match>
              <Match when={true}><p class="hint">This version of git can't check for conflicts beforehand; merge with your git tools.</p></Match>
            </Switch>
          </Match>
        </Switch>
      </Show>
      <TypedConfirm open={confirmMass()} word={c()?.branch ?? ""} confirmLabel="Push anyway"
        question={`This push removes ${c()?.massDelete?.deleted ?? 0} of the remote branch's ${c()?.massDelete?.total ?? 0} files. Are you sure?`}
        onConfirm={() => void push(true)} onCancel={() => setConfirmMass(false)} />
    </div>
  );
}
