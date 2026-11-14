// A version control channel: its main repository and, when they were imported, that repository's submodules, one
// shown at a time (RepoView). Which one is remembered per channel on this device.
import { Show, createMemo, createSignal } from "solid-js";
import { readJson, writeJson } from "../../../core/storage";
import Skeleton from "../../../ui/Skeleton";
import type { ChannelContext } from "../../types";
import { createRepos } from "./data";
import RepoView from "./RepoView";
import "../views.css";
import "./git.css";

export default function GitView(props: { context: ChannelContext }) {
  const ctx = props.context;
  const repos = createRepos(ctx.api, ctx.channel.id);
  const shownKey = `mw.git.shown.${ctx.workspace.id}:${ctx.channel.id}`;
  const [picked, setPicked] = createSignal(readJson<string>(shownKey, ""));
  const show = (sub: string) => {
    writeJson(shownKey, sub);
    setPicked(sub);
  };
  // The main repository when the picked submodule is gone (or was never there).
  const sub = createMemo(() => (repos.value.some((r) => r.subPath === picked()) ? picked() : ""));
  // A new object per repository, so its view starts fresh: nothing of one repository shows in another's.
  const shown = createMemo(() => ({ sub: sub() }));

  return (
    <Show when={repos.loaded} fallback={<div class="view git"><Skeleton kind="list" header={false} /></div>}>
      <Show when={shown()} keyed>
        {(s) => <RepoView context={ctx} sub={s.sub} repos={repos.value} onShow={show} />}
      </Show>
    </Show>
  );
}
