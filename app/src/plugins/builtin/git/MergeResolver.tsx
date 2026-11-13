// Resolving a merge's conflicts before anything is touched (electron/gitOps.js `mergeConflicts`, `mergeResolved`): the
// conflicted files in a list, one file at a time with each conflict's two sides line by line (tick the lines to keep,
// take one side, both or neither, or write the result by hand), and Finish merge once every conflict is decided. Files
// that can't be merged line by line (not text, too big, deleted on one side) take one side's version as it is. The
// choices stay on this device until the merge is made (resolveDrafts.ts).
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { userMessage } from "../../../api/client";
import type {
  GitConflictFile, GitConflicts, GitFileText, GitFileTexts, GitFileVersion, GitMergeTarget, GitResolution,
} from "../../../core/desktop";
import { readJson, writeJson } from "../../../core/storage";
import { highlight } from "../../../markdown/highlight";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import { createProgressive } from "../../../ui/progressive";
import ResizeHandle from "../../../ui/ResizeHandle";
import Skeleton from "../../../ui/Skeleton";
import { plural } from "../../../core/plural";
import { resolvedMessage } from "./actions";
import { parseUnifiedDiff } from "./diff";
import DiffView, { DiffLines } from "./DiffView";
import { gitCall } from "./local";
import {
  diff3, editorText, joinLines, pickKey, pickedLines, preset, resolvedText, startPicks, toDiffLines, togglePick, writtenChoice,
  type ConflictChoice, type Region, type Row, type Side,
} from "./merge";
import { draftKey, dropDrafts, readDraft, reloadDrafts, writeDraft, type FileDecision } from "./resolveDrafts";
import type { WorkingCopy } from "./workingCopy";

type Names = { into: string; from: string };
type ConflictRegion = Extract<Region, { kind: "conflict" }>;
type PlainRegion = Exclude<Region, { kind: "conflict" }>;
// A conflicted file read for resolving: line by line, or one side as a whole (and why).
type Loaded = { mode: "lines"; regions: Region[] } | { mode: "whole"; texts: GitFileTexts; why: "deleted" | "binary" | "large" };

const textOf = (t: GitFileText | null) => (t && "text" in t ? t.text : null);
const decided = (d: FileDecision | null | undefined) => !!d && (d.kind === "whole" || d.choices.every(Boolean));
const anyChoice = (d: FileDecision | null | undefined) => !!d && (d.kind === "whole" || d.choices.some(Boolean));
const widthKey = "mw.git.resolveFilesWidth";

// Plain copies: the versions live in a store, whose proxies can't go through IPC.
const plain = (v: GitFileVersion | null): GitFileVersion | null => (v ? { oid: v.oid, mode: v.mode } : null);

async function readFile(folder: string, file: GitConflictFile): Promise<Loaded> {
  const versions = { base: plain(file.base), receiving: plain(file.receiving), incoming: plain(file.incoming) };
  const texts = await gitCall((git) => git.mergeFile(folder, versions));
  if (!texts.receiving || !texts.incoming) return { mode: "whole", texts, why: "deleted" };
  const sides = [texts.base, texts.receiving, texts.incoming].filter((t): t is GitFileText => t !== null);
  if (sides.some((t) => "tooLarge" in t)) return { mode: "whole", texts, why: "large" };
  if (sides.some((t) => "binary" in t)) return { mode: "whole", texts, why: "binary" };
  const regions = diff3(textOf(texts.base) ?? "", textOf(texts.receiving)!, textOf(texts.incoming)!);
  return regions ? { mode: "lines", regions } : { mode: "whole", texts, why: "large" };
}

// What happened to a conflicted file on each side, before it's read.
const versionsLabel = (f: GitConflictFile, names: Names) =>
  f.unsupported ? "resolve in your git tools" : !f.receiving ? `deleted in ${names.into}` : !f.incoming ? `deleted in ${names.from}`
    : !f.base ? "added on both" : "changed on both";

export default function MergeResolver(props: {
  folder: string;
  wc: WorkingCopy;
  target: GitMergeTarget;
  // The merge was made; `onClose` leaves the choices for later.
  onDone: () => void;
  onClose: () => void;
}) {
  // The conflicted files keep their objects (by path) when read again, so the list doesn't remount.
  const [conflicts, setConflicts] = createStore<{ value: GitConflicts | null }>({ value: null });
  const [loadError, setLoadError] = createSignal("");
  const [decisions, setDecisions] = createStore<Record<string, FileDecision | null>>({});
  // Read files by their versions: a file read again after new commits is read anew.
  const reads = new Map<string, Promise<Loaded>>();
  const read = (file: GitConflictFile) => {
    const key = draftKey(props.folder, file);
    let loading = reads.get(key);
    if (!loading) {
      reads.set(key, (loading = readFile(props.folder, file)));
      loading.catch(() => reads.delete(key));
    }
    return loading;
  };
  // A merge's result can come after the resolver closed (a retry from the status line): nothing here is touched then.
  let open = true;
  onCleanup(() => (open = false));
  const load = async (folder: string, target: GitMergeTarget) => {
    setLoadError("");
    try {
      const found = await gitCall((git) => git.mergeConflicts(folder, target));
      if (!open) return;
      setConflicts("value", reconcile(found, { key: "path" }));
      // The choices saved on this device for these very versions (another window may have made some).
      reloadDrafts();
      setDecisions(reconcile(Object.fromEntries(found.files.map((f) => [f.path, readDraft(draftKey(folder, f))]))));
    } catch (e) {
      if (open) setLoadError(userMessage(e));
    }
  };
  createEffect(on(() => [props.folder, props.target] as const, ([folder, target]) => void load(folder, target)));

  const files = () => conflicts.value?.files ?? [];
  const names = (): Names => ({ into: conflicts.value?.into ?? "", from: conflicts.value?.from ?? "" });
  const decide = (file: GitConflictFile, decision: FileDecision | null) => {
    setDecisions(file.path, decision);
    writeDraft(draftKey(props.folder, file), decision);
  };

  const [selected, setSelected] = createSignal<{ kind: "conflict" | "clean"; path: string } | null>(null);
  createEffect(() => {
    const list = files();
    const s = selected();
    const gone = s && !(s.kind === "conflict" ? list.some((f) => f.path === s.path) : conflicts.value?.clean.includes(s.path));
    if ((!s || gone) && list.length) setSelected({ kind: "conflict", path: list[0].path });
  });
  const selectedFile = () => {
    const s = selected();
    return s?.kind === "conflict" ? files().find((f) => f.path === s.path) ?? null : null;
  };
  // The open file's view goes with its versions: read again with other versions (new commits), it starts anew.
  const selectedKey = () => {
    const f = selectedFile();
    return f ? draftKey(props.folder, f) : null;
  };
  const [cleanOpen, setCleanOpen] = createSignal(false);
  const shownFiles = createProgressive(files, { from: "start", first: 200 });
  const shownClean = createProgressive(() => (cleanOpen() ? conflicts.value?.clean ?? [] : []), { from: "start", first: 200 });

  const resolvedCount = () => files().filter((f) => decided(decisions[f.path])).length;
  // Why Finish merge can't go yet, if it can't.
  const waiting = () => {
    if (conflicts.value?.unsupported.length) return "Some of these conflicts can't be resolved here; merge with your git tools.";
    const left = files().length - resolvedCount();
    return left ? `${left} of ${plural(files().length, "file")} still ${left === 1 ? "needs" : "need"} a decision.` : null;
  };

  const [message, setMessage] = createSignal("");
  const [preparing, setPreparing] = createSignal(false);
  const [error, setError] = createSignal("");
  const [discarding, setDiscarding] = createSignal(false);
  const finish = async () => {
    const c = conflicts.value;
    if (!c || waiting()) return;
    setError("");
    setPreparing(true);
    let resolutions: GitResolution[];
    try {
      resolutions = await Promise.all(c.files.map(async (f): Promise<GitResolution> => {
        const d = decisions[f.path]!;
        if (d.kind === "whole") return { path: f.path, side: d.side };
        const loaded = await read(f);
        const text = loaded.mode === "lines" ? resolvedText(loaded.regions, d.choices.map((x) => x ?? undefined)) : null;
        if (text === null) throw new Error(`${f.path} still has a conflict without a decision.`);
        return { path: f.path, content: text };
      }));
    } catch (e) {
      setError(userMessage(e));
      return;
    } finally {
      setPreparing(false);
    }
    // Copied now: "Stash my changes and merge again" runs this again later, maybe after the resolver closed.
    const { folder, target, onDone } = props;
    const keys = c.files.map((f) => draftKey(folder, f));
    const { receiving, incoming } = c;
    const text = message().trim();
    await props.wc.act("Merging", (dir) => gitCall((git) => git.mergeResolved(dir, { target, receiving, incoming, message: text, files: resolutions })),
      (r) => {
        if (r.ok) {
          dropDrafts(keys);
          // The view's own handler (closes the resolver if it's still open, reads the history again).
          onDone();
        } else if ((r.reason === "moved" || r.reason === "changed") && open) void load(folder, target);
        return resolvedMessage(r);
      });
  };
  const discard = () => {
    setDiscarding(false);
    dropDrafts(files().map((f) => draftKey(props.folder, f)));
    setDecisions(reconcile(Object.fromEntries(files().map((f) => [f.path, null]))));
  };

  const [width, setWidth] = createSignal<number | null>(readJson<number | null>(widthKey, null));

  return (
    <div class="git-merge mw-fade-in">
      <header class="git-merge-head">
        <h3 class="git-merge-title">
          Resolving conflicts
          <Show when={conflicts.value}>
            <span class="muted">: merging <code>{names().from}</code> into <code>{names().into}</code></span>
          </Show>
        </h3>
        <Show when={files().length}>
          <span class="muted">{resolvedCount()} of {plural(files().length, "file")} resolved</span>
        </Show>
        <button class="mw-button mw-box" onClick={() => props.onClose()} title="Your choices stay on this device for later">Close</button>
      </header>
      <Switch>
        <Match when={loadError()}>
          <p class="view-error">{loadError()}</p>
        </Match>
        <Match when={!conflicts.value}><Skeleton kind="list" header={false} /></Match>
        <Match when={!files().length && !conflicts.value!.unsupported.length}>
          <p class="view-note">Nothing conflicts any more; merge it the usual way.</p>
        </Match>
        <Match when={true}>
          <Show when={conflicts.value!.unsupported.length}>
            <div class="view-note warning git-merge-unsupported">
              Some of these conflicts can't be resolved here, so this merge needs your git tools:
              <ul class="git-push-commits"><For each={conflicts.value!.unsupported}>{(m) => <li>{m}</li>}</For></ul>
            </div>
          </Show>
          <div class="git-merge-columns">
            <div class="git-merge-files-panel" style={width() ? { "flex-basis": `${width()}px` } : undefined}>
              <nav class="git-merge-files mw-box mw-scroll-fade" aria-label="Conflicted files">
                <h4 class="git-branch-section">Conflicts</h4>
                <For each={shownFiles.shown()}>
                  {(f) => {
                    const d = () => decisions[f.path];
                    const left = () => d()?.kind === "lines" ? (d() as { choices: unknown[] }).choices.filter((c) => !c).length : null;
                    return (
                      <button class="git-branch git-merge-file" classList={{ active: selected()?.kind === "conflict" && selected()!.path === f.path }}
                        title={`${f.path} (${versionsLabel(f, names())})`} onClick={() => setSelected({ kind: "conflict", path: f.path })}>
                        <span class="git-merge-file-state" classList={{ done: decided(d()), blocked: !!f.unsupported }}>
                          <Icon name={f.unsupported ? "info" : decided(d()) ? "check" : "file"} />
                        </span>
                        <span class="git-branch-name">{f.path}</span>
                        <span class="git-merge-file-note muted">
                          {f.unsupported ? "git tools" : decided(d()) ? "" : left() !== null ? `${left()} left` : "to do"}
                        </span>
                      </button>
                    );
                  }}
                </For>
                <Show when={conflicts.value!.clean.length}>
                  <button class="git-branch" aria-expanded={cleanOpen()} onClick={() => setCleanOpen(!cleanOpen())}>
                    <Icon name={cleanOpen() ? "expanded" : "collapsed"} />
                    <span class="git-branch-name">
                      {conflicts.value!.clean.length === 1 ? "1 other file merges by itself" : `${conflicts.value!.clean.length} other files merge by themselves`}
                    </span>
                  </button>
                  <Collapse open={cleanOpen()}>
                    <For each={shownClean.shown()}>
                      {(path) => (
                        <button class="git-file-name" classList={{ active: selected()?.kind === "clean" && selected()!.path === path }} title={path}
                          onClick={() => setSelected({ kind: "clean", path })}>{path}</button>
                      )}
                    </For>
                  </Collapse>
                </Show>
              </nav>
              <ResizeHandle edge="right" label="Resize the file list"
                setWidth={(w) => setWidth(w === null ? null : Math.min(Math.max(w, 160), 640))} save={() => writeJson(widthKey, width())} />
            </div>
            <section class="git-merge-view" aria-label="Resolving the file">
              <Switch>
                <Match when={selectedFile()?.unsupported}>
                  <div class="git-merge-file-view">
                    <header class="git-merge-file-head"><h4 class="git-diff-path">{selectedFile()!.path}</h4></header>
                    <p class="view-note warning">This kind of conflict can't be resolved here; merge with your git tools. Git says:</p>
                    <p class="hint">{selectedFile()!.unsupported}</p>
                  </div>
                </Match>
                <Match when={selectedKey()}>
                  {/* One view per file and its versions (keyed): its own reading and scroll position. */}
                  <Show when={selectedKey()} keyed>
                    {(_key) => {
                      const file = selectedFile()!;
                      return (
                        <ConflictFile file={file} read={() => read(file)} names={names()} decision={decisions[file.path] ?? null}
                          decide={(d) => decide(file, d)} />
                      );
                    }}
                  </Show>
                </Match>
                <Match when={selected()?.kind === "clean" && conflicts.value}>
                  {(c) => <CleanFile folder={props.folder} receiving={c().receiving} tree={c().tree} path={selected()!.path} />}
                </Match>
              </Switch>
            </section>
          </div>
          <form class="git-merge-finish" onSubmit={(e) => { e.preventDefault(); void finish(); }}>
            <input class="mw-input mw-box" value={message()} onInput={(e) => setMessage(e.currentTarget.value)} maxLength={500}
              placeholder={conflicts.value!.message} aria-label="Merge commit message" />
            <button class="mw-button mw-box accent" type="submit" disabled={!!waiting() || preparing() || !!props.wc.busy()}>
              {props.wc.busy() === "Merging" ? "Merging..." : "Finish merge"}
            </button>
            <button class="mw-button mw-box" type="button" onClick={() => setDiscarding(!discarding())}
              disabled={!files().some((f) => anyChoice(decisions[f.path]))}>Discard my choices</button>
            <span class="hint" classList={{ warning: !!waiting() }}>{waiting() ?? "Nothing is pushed until you push."}</span>
          </form>
          <ConfirmPrompt open={discarding()} question="Discard your choices for these files and start over?" confirmLabel="Discard"
            onConfirm={discard} onCancel={() => setDiscarding(false)} />
          <Collapse open={!!error()}><p class="view-error">{error()}</p></Collapse>
        </Match>
      </Switch>
    </div>
  );
}

// A line of code, highlighted; a line's own "\r" isn't shown.
function Code(props: { text: string }) {
  return <For each={highlight(props.text.replace(/\r$/, ""))}>{(t) => (t.kind === "plain" ? t.text : <span class={`tok-${t.kind}`}>{t.text}</span>)}</For>;
}

function ConflictFile(props: {
  file: GitConflictFile;
  read: () => Promise<Loaded>;
  names: Names;
  decision: FileDecision | null;
  decide: (d: FileDecision | null) => void;
}) {
  const [loaded] = createResource(() => props.read());
  const ready = () => (loaded.state === "ready" ? loaded() : null);
  // A text file's choices, one per conflict; a file read for the first time starts with all of them undecided.
  createEffect(() => {
    const l = ready();
    if (l?.mode !== "lines") return;
    const count = l.regions.filter((r) => r.kind === "conflict").length;
    const d = props.decision;
    if (d?.kind !== "lines" || d.choices.length !== count) props.decide({ kind: "lines", choices: new Array(count).fill(null) });
  });
  const choices = () => (props.decision?.kind === "lines" ? props.decision.choices : []);
  return (
    <div class="git-merge-file-view">
      <header class="git-merge-file-head">
        <h4 class="git-diff-path">{props.file.path}</h4>
        <span class="muted">{versionsLabel(props.file, props.names)}</span>
      </header>
      <Switch>
        <Match when={loaded.error}><p class="view-error">{userMessage(loaded.error)}</p></Match>
        <Match when={!ready()}><Skeleton kind="document" header={false} /></Match>
        <Match when={ready()?.mode === "lines" && (ready() as Extract<Loaded, { mode: "lines" }>)}>
          {(l) => (
            <Show when={choices().length === l().regions.filter((r) => r.kind === "conflict").length}>
              <LinesView regions={l().regions} choices={choices()} names={props.names}
                setChoices={(next) => props.decide({ kind: "lines", choices: next })} />
            </Show>
          )}
        </Match>
        <Match when={ready()?.mode === "whole" && (ready() as Extract<Loaded, { mode: "whole" }>)}>
          {(l) => <WholeView file={props.file} loaded={l()} names={props.names} decision={props.decision} decide={props.decide} />}
        </Match>
      </Switch>
    </div>
  );
}

function LinesView(props: {
  regions: Region[];
  choices: (ConflictChoice | null)[];
  names: Names;
  setChoices: (choices: (ConflictChoice | null)[]) => void;
}) {
  // Each region's conflict number (-1 for the others).
  const numbers = createMemo(() => {
    let k = 0;
    return props.regions.map((r) => (r.kind === "conflict" ? k++ : -1));
  });
  const total = () => props.choices.length;
  const open = () => props.choices.filter((c) => !c).length;
  const setChoice = (k: number, choice: ConflictChoice | null) => props.setChoices(props.choices.map((c, i) => (i === k ? choice : c)));
  const setAll = (side: Side) => props.setChoices(props.regions.filter((r): r is ConflictRegion => r.kind === "conflict").map((r) => preset(r.rows, side)));
  // A big file's regions show a step at a time; going to a conflict shows everything up to it first.
  const shownRegions = createProgressive(() => props.regions, { from: "start", first: 100 });
  const blocks: HTMLElement[] = [];
  const [at, setAt] = createSignal(-1);
  const go = (step: number) => {
    const next = Math.min(Math.max(at() + step, 0), total() - 1);
    shownRegions.reveal(props.regions[numbers().indexOf(next)]);
    requestAnimationFrame(() => blocks[next]?.scrollIntoView({ block: "start", behavior: "smooth" }));
    setAt(next);
  };
  return (
    <div class="git-merge-lines">
      <div class="git-merge-tools">
        <span class="muted">
          {total() ? `${total() - open()} of ${plural(total(), "conflict")} decided` : "The changes in this file merge by themselves; nothing to decide."}
        </span>
        <Show when={total()}>
          <button class="mw-button mw-box" onClick={() => setAll("receiving")} title={`Every conflict as ${props.names.into} has it`}>
            All {props.names.into}
          </button>
          <button class="mw-button mw-box" onClick={() => setAll("incoming")} title={`Every conflict as ${props.names.from} has it`}>
            All {props.names.from}
          </button>
          <button class="icon-button" title="Previous conflict" aria-label="Previous conflict" disabled={at() <= 0} onClick={() => go(-1)}>
            <Icon name="menu-up" />
          </button>
          <button class="icon-button" title="Next conflict" aria-label="Next conflict" disabled={at() >= total() - 1} onClick={() => go(1)}>
            <Icon name="expanded" />
          </button>
        </Show>
      </div>
      <div class="git-merge-scroll mw-scroll-fade">
        <For each={shownRegions.shown()}>
          {(region, i) => (
            <Switch>
              <Match when={region.kind === "conflict" && region}>
                {(c) => (
                  <ConflictBlock region={c()} number={numbers()[i()]} total={total()} names={props.names}
                    choice={props.choices[numbers()[i()]] ?? null} setChoice={(choice) => setChoice(numbers()[i()], choice)}
                    ref={(el) => (blocks[numbers()[i()]] = el)} />
                )}
              </Match>
              <Match when={region.kind !== "conflict" && region}>
                {(r) => <PlainLines region={r()} first={i() === 0} last={i() === props.regions.length - 1} names={props.names} />}
              </Match>
            </Switch>
          )}
        </For>
      </div>
    </div>
  );
}

// Lines no conflict touches: unchanged ones show only next to the conflicts, changes that merged by themselves show
// with where they came from; the rest folds away.
function PlainLines(props: { region: PlainRegion; first: boolean; last: boolean; names: Names }) {
  // The empty "line" after a file's last newline isn't shown.
  const lines = () => (props.last && props.region.lines.at(-1) === "" ? props.region.lines.slice(0, -1) : props.region.lines);
  const changed = () => props.region.kind !== "same";
  const around = () => (changed() ? 6 : 3);
  const head = () => (props.first && !changed() ? 0 : around());
  const tail = () => (props.last && !changed() ? 0 : around());
  // Folding fewer than a few lines saves nothing.
  const folds = () => lines().length - head() - tail() > 2;
  const [open, setOpen] = createSignal(false);
  const middle = createProgressive(() => (open() ? lines().slice(head(), lines().length - tail()) : []), { from: "start", first: 200 });
  const label = () => ({
    same: "", receiving: `from ${props.names.into}`, incoming: `from ${props.names.from}`, both: "the same on both",
  })[props.region.kind];
  const line = (text: string) => <div class="git-diff-line"><code><Code text={text} /></code></div>;
  return (
    <Show when={lines().length}>
      <div class={`git-merge-plain ${props.region.kind}`}>
        <Show when={changed()}><span class="git-merge-plain-label muted">Merged by itself, {label()}</span></Show>
        <div class="git-diff-lines">
          <Show when={folds()} fallback={<For each={lines()}>{line}</For>}>
            <For each={lines().slice(0, head())}>{line}</For>
            <Show when={open()} fallback={
              <button class="git-merge-unfold" onClick={() => setOpen(true)}>
                <Icon name="collapsed" /> {plural(lines().length - head() - tail(), "more line")}
              </button>
            }>
              <For each={middle.shown()}>{line}</For>
            </Show>
            <For each={lines().slice(lines().length - tail())}>{line}</For>
          </Show>
        </div>
      </div>
    </Show>
  );
}

const pickSet = (choice: ConflictChoice | null) => new Set(choice && "picks" in choice ? choice.picks : []);
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...b].every((p) => a.has(p));

function ConflictBlock(props: {
  region: ConflictRegion;
  number: number;
  total: number;
  names: Names;
  choice: ConflictChoice | null;
  setChoice: (choice: ConflictChoice | null) => void;
  ref: (el: HTMLElement) => void;
}) {
  const rows = () => props.region.rows;
  // An undecided conflict shows its starting ticks: the lines both sides share.
  const shown = (): ConflictChoice => props.choice ?? { picks: startPicks(rows()) };
  const edited = () => !!props.choice && "text" in props.choice;
  const result = createMemo(() => pickedLines(rows(), shown()));
  const list = createProgressive(rows, { from: "start", first: 200 });
  // Sets, once per change: every line's checkbox and every preset button asks.
  const picked = createMemo(() => pickSet(shown()));
  const presets = [
    { id: "receiving", label: "Receiving", title: () => `Only ${props.names.into}'s lines` },
    { id: "incoming", label: "Incoming", title: () => `Only ${props.names.from}'s lines` },
    { id: "both", label: "Both", title: () => `${props.names.into}'s lines, then ${props.names.from}'s` },
    { id: "neither", label: "Neither", title: () => "Only the lines both sides have" },
  ] as const;
  const presetSets = createMemo(() => new Map(presets.map((p) => [p.id, pickSet(preset(rows(), p.id))])));
  const cell = (row: Row, n: number, side: Side) => {
    const text = side === "receiving" ? row.receiving : row.incoming;
    const isPicked = () => picked().has(pickKey(n, side));
    return (
      <label class={`git-merge-cell ${side}`} classList={{ empty: text === null, shared: row.shared, off: text !== null && !edited() && !isPicked() }}>
        <Show when={text !== null}>
          <input type="checkbox" checked={isPicked()} disabled={edited()}
            onChange={() => props.setChoice(togglePick(rows(), props.choice ?? undefined, n, side))}
            aria-label={`Keep this line of ${side === "receiving" ? props.names.into : props.names.from}`} />
          <code><Code text={text!} /></code>
        </Show>
      </label>
    );
  };
  return (
    <section ref={props.ref} class="git-merge-conflict mw-box" classList={{ undecided: !props.choice }}
      aria-label={`Conflict ${props.number + 1} of ${props.total}`}>
      <header class="git-merge-conflict-head">
        <span class="git-merge-conflict-title">Conflict {props.number + 1} of {props.total}</span>
        <Show when={!props.choice}><span class="git-merge-undecided">Undecided</span></Show>
        <div class="git-merge-choices">
          <For each={presets}>
            {(p) => (
              <button class="mw-button mw-box" classList={{ active: !!props.choice && !edited() && sameSet(picked(), presetSets().get(p.id)!) }}
                title={p.title()}
                onClick={() => props.setChoice(preset(rows(), p.id))}>{p.label}</button>
            )}
          </For>
          {/* From the lines ticked so far; an undecided conflict starts with both sides' lines to cut down. */}
          <button class="mw-button mw-box" classList={{ active: edited() }} disabled={edited()} title="Write the result yourself"
            onClick={() => props.setChoice({ text: joinLines(props.choice ? result() : pickedLines(rows(), preset(rows(), "both"))) })}>
            <Icon name="rename" /> Edit
          </button>
          <Show when={props.choice}>
            <button class="icon-button" title="Start this conflict over" aria-label="Start this conflict over" onClick={() => props.setChoice(null)}>
              <Icon name="undo" />
            </button>
          </Show>
        </div>
      </header>
      <div class="git-merge-sides git-diff-lines" classList={{ edited: edited() }}>
        <div class="git-merge-side-head"><code>{props.names.into}</code> <span class="muted">receiving</span></div>
        <div class="git-merge-side-head"><code>{props.names.from}</code> <span class="muted">incoming</span></div>
        <For each={list.shown()}>{(row, n) => <>{cell(row, n(), "receiving")}{cell(row, n(), "incoming")}</>}</For>
      </div>
      <div class="git-merge-result">
        <h5 class="git-merge-result-head">Result<Show when={edited()}><span class="muted"> · written by hand</span></Show></h5>
        <Switch>
          <Match when={edited()}>
            {/* The box holds the lines without "\r"; writtenChoice puts the conflict's line ending back. */}
            <textarea class="mw-input mw-box git-merge-edit" value={editorText(result())} spellcheck={false} aria-label="The result, written by hand"
              rows={Math.min(Math.max(result().length + 1, 3), 24)} onInput={(e) => props.setChoice(writtenChoice(rows(), e.currentTarget.value))} />
          </Match>
          <Match when={true}>
            <div class="git-diff-lines git-merge-result-lines mw-fade-in">
              <For each={result()} fallback={
                <p class="view-note">{props.choice ? "No lines: neither side's lines are kept here." : "Tick the lines to keep, or choose above."}</p>
              }>
                {(text) => <div class="git-diff-line"><code><Code text={text} /></code></div>}
              </For>
            </div>
          </Match>
        </Switch>
      </div>
    </section>
  );
}

// A file decided as a whole: one side's version as it is (or no file, where that side deleted it).
function WholeView(props: {
  file: GitConflictFile;
  loaded: Extract<Loaded, { mode: "whole" }>;
  names: Names;
  decision: FileDecision | null;
  decide: (d: FileDecision | null) => void;
}) {
  const why = () => {
    switch (props.loaded.why) {
      case "deleted": {
        const [gone, kept] = props.file.receiving ? [props.names.from, props.names.into] : [props.names.into, props.names.from];
        return `${gone} deleted this file and ${kept} changed it: keep the changed file, or delete it.`;
      }
      case "binary": return "This file isn't text, so it can't be merged line by line here: choose one branch's version.";
      case "large": return "This file is too big to merge line by line here: choose one branch's version.";
    }
  };
  const sides = [
    { side: "receiving" as const, branch: () => props.names.into },
    { side: "incoming" as const, branch: () => props.names.from },
  ];
  return (
    <div class="git-merge-whole git-merge-scroll mw-scroll-fade">
      <p class="hint">{why()}</p>
      <For each={sides}>
        {(s) => {
          const exists = () => !!props.file[s.side];
          const active = () => props.decision?.kind === "whole" && props.decision.side === s.side;
          const text = () => textOf(props.loaded.texts[s.side]);
          const [showing, setShowing] = createSignal(false);
          // Compared only once shown: these can be big files.
          const preview = createMemo(() => (showing() && text() !== null ? toDiffLines(textOf(props.loaded.texts.base) ?? "", text()!) : null));
          return (
            <section class="git-merge-card mw-box" classList={{ active: active() }}>
              <button class="git-merge-card-pick" aria-pressed={active()} onClick={() => props.decide({ kind: "whole", side: s.side })}>
                <Icon name={active() ? "check" : exists() ? "file" : "delete"} />
                <span class="git-merge-card-title">{exists() ? `Use ${s.branch()}'s version` : `Delete it, as ${s.branch()} did`}</span>
                <span class="muted">{s.side}</span>
              </button>
              <Show when={text() !== null}>
                <button class="git-merge-unfold" aria-expanded={showing()} onClick={() => setShowing(!showing())}>
                  <Icon name={showing() ? "expanded" : "collapsed"} /> {showing() ? "Hide its changes" : "Show its changes"}
                </button>
                <Collapse open={showing()}>
                  <Switch>
                    <Match when={preview()?.length}><DiffLines lines={preview()!} /></Match>
                    <Match when={preview()}><p class="view-note">No line changes.</p></Match>
                    <Match when={showing()}><p class="view-note">Too big to compare here.</p></Match>
                  </Switch>
                </Collapse>
              </Show>
            </section>
          );
        }}
      </For>
    </div>
  );
}

// A file that merges by itself: the receiving branch's version against the merged one.
function CleanFile(props: { folder: string; receiving: string; tree: string; path: string }) {
  const [patch] = createResource(() => props.path, (path) => gitCall((git) => git.mergeDiff(props.folder, props.receiving, props.tree, path)));
  return (
    <div class="git-merge-file-view">
      <p class="hint">This file merges by itself; there is nothing to decide.</p>
      <div class="git-merge-scroll mw-scroll-fade">
        <Switch>
          <Match when={patch.error}><p class="view-error">{userMessage(patch.error)}</p></Match>
          <Match when={patch.state !== "ready"}><Skeleton kind="document" header={false} /></Match>
          <Match when={patch.state === "ready" && patch()}>
            {(p) => <DiffView files={parseUnifiedDiff(p().patch)} truncated={p().truncated} empty="No line changes." />}
          </Match>
        </Switch>
      </div>
    </div>
  );
}
