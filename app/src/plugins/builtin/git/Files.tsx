// Every file at a branch of the folder on this device, filtered by name; choosing one shows its blame.
import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { userMessage } from "../../../api/client";
import Select from "../../../ui/Select";
import { Icon } from "../../../theme/icons";
import BlameView from "./BlameView";
import { gitCall } from "./local";

// More matches than this are cut off; the filter narrows them down.
const shownUpTo = 500;

// `openSubmodule`: shows one of the channel's submodules, by its path in this repository; absent for paths that aren't
// one (a submodule is a commit, not a file, so it has no blame).
export default function Files(props: { folder: string; onCommit: (sha: string) => void; openSubmodule?: (path: string) => (() => void) | undefined }) {
  const [branches] = createResource(() => props.folder, (folder) => gitCall((git) => git.branchList(folder)));
  const [rev, setRev] = createSignal<string | null>(null);
  const shownRev = () => rev() ?? branches()?.current ?? branches()?.branches[0]?.name ?? null;
  const [files] = createResource(() => shownRev() && [props.folder, shownRev()!] as const,
    ([folder, at]) => gitCall((git) => git.files(folder, at)));
  const [filter, setFilter] = createSignal("");
  const matches = createMemo(() => {
    const words = filter().toLowerCase().split(/\s+/).filter(Boolean);
    return (files() ?? []).filter((f) => words.every((w) => f.toLowerCase().includes(w)));
  });
  const [chosen, setChosen] = createSignal<string | null>(null);

  return (
    <div class="git-files">
      <section class="git-files-list mw-box" aria-label="Files">
        <div class="git-files-tools">
          <Select label="Branch" value={shownRev()} onChange={(v) => { setRev(v); setChosen(null); }}
            options={(branches()?.branches ?? []).map((b) => ({ value: b.name, label: b.name, icon: "channel-git" }))} />
          <input class="mw-input mw-box" placeholder="Filter files" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
        </div>
        <Show when={!files.error} fallback={<p class="view-error">{userMessage(files.error)}</p>}>
          <ul class="git-file-names mw-scroll-fade">
            <For each={matches().slice(0, shownUpTo)} fallback={<li class="view-note">{files.loading ? "Reading files..." : "No files match."}</li>}>
              {(f) => (
                <li>
                  <Show when={props.openSubmodule?.(f)} fallback={
                    <button class="git-file-name" classList={{ active: chosen() === f }} onClick={() => setChosen(f)} title={f}>{f}</button>
                  }>
                    {(open) => <button class="git-file-name" onClick={() => open()()} title={`Show the submodule ${f}`}><Icon name="folder" /> {f}</button>}
                  </Show>
                </li>
              )}
            </For>
            <Show when={matches().length > shownUpTo}>
              <li class="view-note">{(matches().length - shownUpTo).toLocaleString()} more; type to narrow them down.</li>
            </Show>
          </ul>
        </Show>
      </section>
      <section class="git-files-blame mw-scroll-fade" aria-label="Blame">
        <Show when={chosen() && shownRev()} fallback={<p class="view-note">Choose a file to see who last changed each line.</p>}>
          <BlameView folder={props.folder} rev={shownRev()!} path={chosen()!} onCommit={props.onCommit} />
        </Show>
      </section>
    </div>
  );
}
