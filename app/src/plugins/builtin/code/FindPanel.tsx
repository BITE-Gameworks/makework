// Find in files: the open file's live text and the kept content of the other files; files whose content isn't on
// this device are counted, not searched.
import { For, Show, createSignal, onCleanup } from "solid-js";
import { storedBlob, refHash } from "../../../core/content";
import { Icon } from "../../../theme/icons";
import Skeleton from "../../../ui/Skeleton";
import { isTextBlob, type CodeFile } from "./data";

export interface Hit {
  file: CodeFile;
  offset: number;
  length: number;
  line: number;
  before: string;
  match: string;
  after: string;
}

const textLimit = 1024 * 1024;
const maxHits = 500;

export default function FindPanel(props: {
  files: () => CodeFile[];
  pathOf: (file: CodeFile) => string;
  liveText: (id: number) => string | null;
  onOpen: (hit: Hit) => void;
}) {
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<Hit[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [missing, setMissing] = createSignal(0);
  let run = 0;

  const search = async (value: string) => {
    const mine = ++run;
    setQuery(value);
    if (!value) { setHits([]); setMissing(0); setBusy(false); return; }
    setBusy(true);
    const found: Hit[] = [];
    let absent = 0;
    const needle = value.toLowerCase();
    for (const file of props.files()) {
      if (file.kind !== "file" || found.length >= maxHits) continue;
      let text = props.liveText(file.id);
      if (text === null) {
        const hash = refHash(file.hash);
        if (!hash || file.size > textLimit) continue;
        const blob = await storedBlob(hash);
        if (!blob) { absent++; continue; }
        if (!(await isTextBlob(blob))) continue;
        text = await blob.text();
      }
      if (mine !== run) return;
      const lower = text.toLowerCase();
      for (let at = lower.indexOf(needle); at >= 0 && found.length < maxHits; at = lower.indexOf(needle, at + needle.length)) {
        const start = text.lastIndexOf("\n", at - 1) + 1;
        const end = text.indexOf("\n", at);
        const line = text.slice(start, end < 0 ? undefined : end);
        const column = at - start;
        found.push({
          file, offset: at, length: needle.length, line: text.slice(0, at).split("\n").length,
          before: line.slice(Math.max(0, column - 30), column), match: line.slice(column, column + needle.length), after: line.slice(column + needle.length, column + needle.length + 60),
        });
      }
    }
    if (mine !== run) return;
    setHits(found);
    setMissing(absent);
    setBusy(false);
  };
  onCleanup(() => { run++; });

  return <div class="code-find">
    <input class="mw-input mw-box" placeholder="Find in files" aria-label="Find in files" value={query()} ref={(el) => queueMicrotask(() => el.focus())}
      onInput={(event) => void search(event.currentTarget.value)} />
    <Show when={busy()}><Skeleton kind="line" /></Show>
    <div class="code-find-results mw-scroll-fade">
      <For each={hits()}>{(hit) =>
        <button class="code-find-hit" onClick={() => props.onOpen(hit)}>
          <span class="code-find-file"><Icon name="code-file" size={12} /> {props.pathOf(hit.file)}:{hit.line}</span>
          <span class="code-find-line">{hit.before}<mark>{hit.match}</mark>{hit.after}</span>
        </button>}</For>
      <Show when={!busy() && query() && !hits().length}><p class="code-find-note">No results.</p></Show>
      <Show when={hits().length >= maxHits}><p class="code-find-note">Showing the first {maxHits} results.</p></Show>
      <Show when={missing() > 0}><p class="code-find-note">{missing() === 1 ? "1 file was" : `${missing()} files were`} not searched because the content isn't on this device yet.</p></Show>
    </div>
  </div>;
}
