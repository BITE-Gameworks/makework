import { For, Match, Show, Switch, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import { userMessage } from "../../../api/client";
import { desktop, desktopError, type BuildCollect, type BuildPlan, type LocalFile } from "../../../core/desktop";
import { readJson, writeJson } from "../../../core/storage";
import { formatBytes } from "../../../core/time";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import Skeleton from "../../../ui/Skeleton";
import { ProgressBar } from "../../../ui/UploadList";
import type { ChannelContext } from "../../types";
import { approveBuild, collectText, copyBuild, createBuilds, mayBuild, saveBuild, systemName, type BuildConfig } from "./builds";
import { localFolder, type Repo } from "./data";
import { nextTag, uploadFile } from "./github";
import type { Attachment, ReleaseHost } from "./releases";
import Select, { type SelectOption } from "../../../ui/Select";
import Combobox from "../../../ui/Combobox";

interface Listed extends Attachment {
  // "built" by the build below, or "added" by hand.
  origin: "built" | "added";
}

// Creating a release on the repository's host (GitHub or GitLab, through the member's host connection): branch,
// tag, title, description, and the release files, built here from a project folder (desktop) or added by hand.
// How the files and the release go up is the host's (releases.ts). `onFailed` lets the view check the connection
// again; `connected` false: it can't write here any more (the page stays, with what was built and typed).
export default function ReleasePage(props: {
  context: ChannelContext;
  repo: Repo;
  host: ReleaseHost;
  branches: { name: string; head: string }[];
  token: string;
  connected: boolean;
  onBack: () => void;
  onFailed: () => void;
}) {
  const ctx = props.context;
  const place = `${ctx.workspace.id}:${ctx.channel.id}`;
  const ordered = () => [...props.branches].sort((a, b) =>
    Number(b.name === props.repo.defaultBranch) - Number(a.name === props.repo.defaultBranch) || a.name.localeCompare(b.name));
  const [tags] = createResource(() => props.host.listTags(props.token).catch(() => [] as string[]));
  const [branch, setBranch] = createSignal(ordered()[0]?.name ?? props.repo.defaultBranch);
  const [tag, setTag] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [draft, setDraft] = createSignal(false);
  const [prerelease, setPrerelease] = createSignal(false);
  const [files, setFiles] = createSignal<Listed[]>([]);
  const [progress, setProgress] = createSignal<Record<string, number>>({});
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal<"" | "notes" | "publishing">("");
  const [result, setResult] = createSignal<{ url: string; failed?: string } | null>(null);
  createEffect(() => !tag() && tags() && setTag(nextTag(tags()!)));
  const tagTaken = () => !!tags()?.includes(tag().trim());

  const fromDisk = (f: LocalFile, origin: Listed["origin"]): Listed => ({
    key: f.path, name: f.name, size: f.size, origin,
    async upload(to, onProgress) {
      const off = desktop!.release!.onProgress((file, done) => file === f.path && onProgress(done));
      try {
        await desktop!.release!.upload(to, f.path, f.name);
      } catch (e) {
        throw desktopError(e);
      } finally {
        off();
      }
    },
  });
  const add = (more: Listed[]) => setFiles([...files().filter((f) => !more.some((m) => m.name === f.name)), ...more]);
  const buildRun = desktop?.release ? createBuildRun(ctx, (built) => add(built.map((f) => fromDisk(f, "built"))), setError) : null!;

  const notes = async () => {
    setBusy("notes");
    try {
      setBody(await props.host.generateNotes(props.token, tag().trim(), branch()));
      setError("");
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy("");
    }
  };

  const publish = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy("publishing");
    setError("");
    setProgress({});
    try {
      const done = await props.host.publish(props.token,
        { tag: tag().trim(), target: branch(), name: title().trim(), body: body(), prerelease: props.host.prereleases && prerelease() },
        files(), props.host.drafts && draft(), (key, part) => setProgress({ ...progress(), [key]: part }));
      setResult(done);
      ctx.playSound(done.failed ? "error" : "upload-done");
    } catch (err) {
      setError(userMessage(err));
      ctx.playSound("error");
      props.onFailed();
    } finally {
      setBusy("");
    }
  };

  return (
    <form class="git-release mw-fade-in" onSubmit={(e) => void publish(e)}>
      <div class="git-release-head">
        <button class="mw-button mw-box" type="button" onClick={() => props.onBack()}><Icon name="back" /> Back</button>
        <h3>New release of {props.host.target.path} on {props.host.name}</h3>
      </div>
      <Collapse open={!!error()}><p class="view-error">{error()}</p></Collapse>
      <Collapse open={!props.connected && !result()}>
        <p class="view-error">
          Your {props.host.name} connection can't write to this repository any more. Pick or add a connection for {props.host.target.host}
          from the More menu, then publish again.
        </p>
      </Collapse>

      <Show when={result()} fallback={
        <div class="git-release-columns">
          <section class="git-release-fields">
            <label>
              <span>Branch</span>
              <Select label="Branch" value={branch()} options={ordered().map((b) => ({ value: b.name, label: b.name }))} onChange={setBranch} />
            </label>
            <label>
              <span>Tag {tagTaken() && <span class="warning">already exists</span>}</span>
              <Combobox label="Tag" required value={tag()} suggestions={tags() ?? []} onInput={setTag} onCommit={setTag} />
            </label>
            <label>
              <span>Title</span>
              <input class="mw-input mw-box" placeholder={tag()} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
            </label>
            <label class="git-release-body">
              <span>
                Description
                <button class="mw-button mw-box" type="button" disabled={!tag().trim() || busy() !== ""} onClick={() => void notes()}>
                  {busy() === "notes" ? "Generating..." : "Generate from commits"}
                </button>
              </span>
              <textarea class="mw-input mw-box" rows={10} value={body()} onInput={(e) => setBody(e.currentTarget.value)} />
            </label>
            <Show when={props.host.drafts || props.host.prereleases}>
              <div class="git-release-checks">
                <Show when={props.host.drafts}>
                  <label class="git-check"><input type="checkbox" checked={draft()} onChange={(e) => setDraft(e.currentTarget.checked)} /> Keep as a draft</label>
                </Show>
                <Show when={props.host.prereleases}>
                  <label class="git-check"><input type="checkbox" checked={prerelease()} onChange={(e) => setPrerelease(e.currentTarget.checked)} /> Pre-release</label>
                </Show>
              </div>
            </Show>
          </section>

          <section class="git-release-files">
            <h4>Files</h4>
            <Show when={desktop?.release} fallback={
              <label class="mw-button mw-box git-release-pick">
                <Icon name="attach" /> Add files...
                <input type="file" multiple hidden onChange={(e) => {
                  add([...(e.currentTarget.files ?? [])].map((file): Listed => ({
                    key: `${file.name}:${file.size}`, name: file.name, size: file.size, origin: "added",
                    upload: (to) => uploadFile(to, file),
                  })));
                  e.currentTarget.value = "";
                }} />
              </label>
            }>
              <Builder context={ctx} place={place} branch={branch()} disabled={busy() !== ""} run={buildRun} onError={setError} />
              <BuildLog run={buildRun} />
              <button class="mw-button mw-box git-release-pick" type="button" disabled={busy() !== ""}
                onClick={() => void desktop!.release!.pickFiles().then((picked) => add(picked.map((f) => fromDisk(f, "added"))), (e) => setError(userMessage(desktopError(e))))}>
                <Icon name="attach" /> Add files...
              </button>
            </Show>
            <ul class="git-release-list">
              <For each={files()} fallback={<li class="muted">No files yet. A release can also go out without any.</li>}>
                {(f) => (
                  <li class="git-release-file mw-box mw-fade-in">
                    <Icon name="file" />
                    <span class="git-release-name">{f.name}</span>
                    <span class="muted">{formatBytes(f.size)}</span>
                    <button class="icon-button" type="button" title="Remove" aria-label={`Remove ${f.name}`} disabled={busy() !== ""}
                      onClick={() => setFiles(files().filter((x) => x !== f))}><Icon name="close" /></button>
                    <Show when={progress()[f.key] !== undefined}><ProgressBar value={progress()[f.key]} label={`Uploading ${f.name}`} /></Show>
                  </li>
                )}
              </For>
            </ul>
          </section>

          {/* Under the fields, beside the files column: a build editor opening there never moves it. */}
          <div class="git-release-actions">
            <button class="mw-button mw-box accent" type="submit" disabled={busy() !== "" || !tag().trim() || tagTaken()}>
              {busy() === "publishing" ? "Publishing..." : props.host.drafts && draft() ? "Save draft" : "Publish release"}
            </button>
            <span class="hint">{props.host.hint}</span>
          </div>
        </div>
      }>
        {(r) => (
          <div class="git-release-done mw-fade-in">
            <p><Icon name={r().failed ? "info" : "check"} /> {r().failed ?? (props.host.drafts && draft() ? `The draft is on ${props.host.name}.` : "The release is published.")}</p>
            <p><a href={r().url} target="_blank" rel="noreferrer">{r().url}</a></p>
          </div>
        )}
      </Show>

      <Show when={result()}>
        <div class="git-release-actions">
          <button class="mw-button mw-box" type="button" onClick={() => props.onBack()}>Back to the history</button>
        </div>
      </Show>
    </form>
  );
}

// One build at a time on the page, with its log panel and Stop.
interface BuildRun {
  running: () => boolean;
  log: () => string[];
  start(build: () => Promise<LocalFile[]>): Promise<void>;
}

function createBuildRun(ctx: ChannelContext, onBuilt: (files: LocalFile[]) => void, onError: (message: string) => void): BuildRun {
  const [running, setRunning] = createSignal(false);
  const [log, setLog] = createSignal<string[]>([]);
  onCleanup(() => running() && desktop!.release!.stop());
  return {
    running,
    log,
    async start(build) {
      setRunning(true);
      setLog([]);
      const off = desktop!.release!.onLog((line) => setLog([...log().slice(-400), line]));
      try {
        onBuilt(await build());
        ctx.playSound("task-done");
      } catch (e) {
        onError(userMessage(desktopError(e)));
        ctx.playSound("error");
      } finally {
        off();
        setRunning(false);
      }
    },
  };
}

function BuildLog(props: { run: BuildRun }) {
  let box!: HTMLPreElement;
  createEffect(() => props.run.log().length && requestAnimationFrame(() => (box.scrollTop = box.scrollHeight)));
  return (
    <Collapse open={props.run.log().length > 0}>
      <div class="git-build-log-wrap">
        <pre class="git-build-log mw-box" ref={box}>{props.run.log().join("\n")}</pre>
        <Show when={props.run.running()}>
          <button class="mw-button mw-box" type="button" onClick={() => desktop!.release!.stop()}><Icon name="close" /> Stop</button>
        </Show>
      </div>
    </Collapse>
  );
}

type Draft = { id: number | null; name: string; plan: BuildPlan };
const emptyPlan = (): BuildPlan => ({ project: ".", steps: [], output: ".", collect: { kind: "binaries" } });

// Builds the release files from a project folder on this computer, for the chosen branch as committed (in a
// temporary copy): with one of the channel's build configurations, or the usual build of the project found there.
// With neither, the page asks for the commands.
function Builder(props: {
  context: ChannelContext;
  place: string;
  branch: string;
  disabled: boolean;
  run: BuildRun;
  onError: (message: string) => void;
}) {
  const ctx = props.context;
  const folderKey = `mw.git.buildFolder.${props.place}`;
  const chosenKey = `mw.git.build.${props.place}`;
  const [folder, setFolder] = createSignal<string | null>(localFolder(ctx.workspace.id, ctx.channel.id) ?? readJson<string | null>(folderKey, null));
  const [found] = createResource(folder, (f) => desktop!.release!.inspect(f).catch(() => null));
  const builds = createBuilds(ctx.api, ctx.channel.id);
  // The chosen build configuration by id and name: a new row's id can change once right after it is written (an id
  // two devices drew at once), and its name still finds it then. "found": the usual build.
  type Chosen = { id: number; name: string } | "found";
  const [chosen, setChosen] = createSignal<Chosen>(readJson<Chosen>(chosenKey, "found"));
  const [editing, setEditing] = createSignal<Draft | null>(null);
  // What the prompt shows, copied when it opened: confirming runs exactly that.
  const [confirming, setConfirming] = createSignal<BuildConfig | null>(null);
  const [removing, setRemoving] = createSignal(false);
  const running = () => props.run.running();
  const canEdit = () => ctx.can("edit_content");
  // The chosen build configuration; none once it was removed, or while "the usual build" is chosen.
  const config = () => {
    const c = chosen();
    if (c === "found") return null;
    return builds.value.find((b) => b.id === c.id) ?? builds.value.find((b) => b.name === c.name) ?? null;
  };
  const unknown = () => !found.loading && !found() && builds.loaded && builds.value.length === 0;
  // The editor stays open while nothing is known to build: there is nothing else to do then. One draft object, so
  // the editor isn't made again (losing what was typed) each time something it depends on changes.
  const blank: Draft = { id: null, name: "", plan: emptyPlan() };
  const draft = () => editing() ?? (unknown() && canEdit() ? blank : null);
  const [shownDraft, setShownDraft] = createSignal<Draft | null>(null);
  createEffect(() => draft() && setShownDraft(draft()));

  const choose = (value: Chosen) => {
    setChosen(value);
    writeJson(chosenKey, value);
  };
  const chooseValue = (value: number | "found") =>
    choose(value === "found" ? "found" : { id: value, name: builds.value.find((b) => b.id === value)?.name ?? "" });

  const pick = async () => {
    try {
      const picked = await desktop!.git!.pickFolder();
      if (!picked) return;
      setFolder(picked.path);
      writeJson(folderKey, picked.path);
    } catch (e) {
      props.onError(userMessage(desktopError(e)));
    }
  };

  // `with_` is a copy (copyBuild), never the live row.
  const build = (with_: BuildConfig | null) => props.run.start(() => desktop!.release!.build(folder()!, props.branch, with_?.plan ?? null));
  const start = () => {
    const live = config();
    const c = live && copyBuild(live);
    if (c && !mayBuild(props.place, c, ctx.users.me())) return setConfirming(c);
    void build(c);
  };

  const save = async (id: number | null, name: string, plan: BuildPlan) => {
    try {
      const saved = await saveBuild(ctx.api, ctx.channel.id, id, name, plan);
      await builds.refresh();
      choose({ id: saved, name });
      setEditing(null);
    } catch (e) {
      props.onError(userMessage(e));
    }
  };

  const remove = async () => {
    const c = config();
    setRemoving(false);
    if (!c) return;
    try {
      await ctx.api.call("remove-build", { build_id: c.id });
      await builds.refresh();
      choose("found");
    } catch (e) {
      props.onError(userMessage(e));
    }
  };

  const options = (): SelectOption<number | "found">[] => [
    { value: "found", label: found() ? `Usual build: ${found()!.label}` : "Usual build (not recognized)", disabled: !found() },
    ...builds.value.map((b) => ({ value: b.id, label: b.name })),
  ];

  return (
    <div class="git-builder">
      <p class="git-builder-folder">
        <Icon name="folder" />
        <span class="git-source-text">{folder() ?? "No project folder on this computer yet"}</span>
        <button class="mw-button mw-box" type="button" disabled={running()} onClick={() => void pick()}>{folder() ? "Change" : "Choose..."}</button>
      </p>
      <Show when={folder()}>
        <Show when={builds.value.length > 0}>
          <label>
            <span>Build</span>
            <Select label="Build" value={config() ? config()!.id : "found"} options={options()} onChange={chooseValue} disabled={running()} />
          </label>
        </Show>
        <Switch>
          <Match when={config()}>
            {(c) => (
              <BuildSummary plan={c().plan} heading={`${c().name}, set by ${ctx.users.get(c().updatedBy).displayName}`} notes={[
                c().system && desktop!.platform !== c().system &&
                  { text: `Written on ${systemName(c().system)}; it may not work on ${systemName(desktop!.platform)}.`, warn: true },
              ]} />
            )}
          </Match>
          <Match when={found.loading}><Skeleton kind="line" /></Match>
          <Match when={found()}>
            {(f) => (
              <BuildSummary plan={f().plan} heading={`Recognized: ${f().label}`} notes={[
                f().missing.length > 0 && { text: `Needs ${f().missing.join(", ")} on this computer.`, warn: true },
                f().note && { text: f().note! },
                { text: `Read again from branch ${props.branch} when it builds.` },
              ]} />
            )}
          </Match>
          <Match when={true}>
            <p class="hint">
              This project's build isn't recognized. {canEdit() ? "Enter the commands that build it." : "A member with Edit content can add the commands that build it."}
            </p>
          </Match>
        </Switch>
        <Collapse open={!!draft()}>
          <Show when={shownDraft()} keyed>
            {(d) => <BuildEditor draft={d} disabled={running()} canCancel={!unknown()} onSave={save} onCancel={() => setEditing(null)} />}
          </Show>
        </Collapse>
        <div class="git-setup-buttons">
          <button class="mw-button mw-box accent" type="button" disabled={props.disabled || running() || (!config() && !found())} onClick={start}>
            <Icon name="refresh" /> Build branch {props.branch}
          </button>
          <Show when={canEdit() && !draft()}>
            <Show when={config()}>
              {(c) => (
                <>
                  <button class="mw-button mw-box" type="button" disabled={running()} onClick={() => setEditing({ id: c().id, name: c().name, plan: c().plan })}>
                    <Icon name="rename" /> Edit
                  </button>
                  <button class="mw-button mw-box" type="button" disabled={running()} onClick={() => setRemoving(true)}><Icon name="delete" /> Remove</button>
                </>
              )}
            </Show>
            <button class="mw-button mw-box" type="button" disabled={running()}
              onClick={() => setEditing({ id: null, name: found()?.label ?? "", plan: config()?.plan ?? found()?.plan ?? emptyPlan() })}>
              <Icon name="add" /> New build configuration
            </button>
          </Show>
        </div>
        <ConfirmPrompt open={confirming() !== null} confirmLabel="Build"
          question={confirming() ? confirmText(ctx.users.get(confirming()!.updatedBy).displayName, confirming()!) : ""}
          onConfirm={() => {
            const c = confirming();
            setConfirming(null);
            if (!c) return;
            approveBuild(props.place, c);
            void build(c);
          }}
          onCancel={() => setConfirming(null)} />
        <ConfirmPrompt open={removing()} confirmLabel="Remove" question={`Remove the build configuration "${config()?.name ?? ""}" for everyone?`}
          onConfirm={() => void remove()} onCancel={() => setRemoving(false)} />
      </Show>
    </div>
  );
}

// Agreeing covers the whole configuration, so the question names the folders too: the same commands in another
// folder can run another project's scripts.
function confirmText(who: string, c: BuildConfig): string {
  const where = c.plan.project === "." ? "the repository root" : c.plan.project;
  return `${who} set "${c.name}" to run, in ${where}: ${c.plan.steps.join(" && ")}  and take ${collectText(c.plan.collect).toLowerCase()} from `
    + `${c.plan.output === "." ? "that folder" : c.plan.output}. Run it on this computer?`;
}

// What a build runs and takes, before it runs.
function BuildSummary(props: { plan: BuildPlan; heading: string; notes: (false | "" | null | undefined | { text: string; warn?: boolean })[] }) {
  const folder = (value: string) => (value === "." ? "the project folder" : value);
  return (
    <div class="git-build-summary mw-fade-in">
      <p class="git-build-heading">{props.heading}</p>
      <ol class="git-build-steps">
        <For each={props.plan.steps}>{(step) => <li><code>{step}</code></li>}</For>
      </ol>
      <p class="hint">
        Runs in <code>{props.plan.project === "." ? "the repository root" : props.plan.project}</code>; takes {collectText(props.plan.collect).toLowerCase()} from{" "}
        <code>{folder(props.plan.output)}</code>.
      </p>
      <For each={props.notes.filter((n): n is { text: string; warn?: boolean } => !!n)}>
        {(n) => <p class="hint" classList={{ warning: !!n.warn }}>{n.text}</p>}
      </For>
    </div>
  );
}

const collectOptions: SelectOption<BuildCollect["kind"]>[] = (["binaries", "installers", "zip", "pattern"] as const)
  .map((kind) => ({ value: kind, label: kind === "pattern" ? "Files matching a pattern" : collectText({ kind }) }));

// A build configuration's fields. Saving shares it with the channel; others' devices ask before running it.
function BuildEditor(props: {
  draft: Draft;
  disabled: boolean;
  canCancel: boolean;
  onSave: (id: number | null, name: string, plan: BuildPlan) => Promise<void>;
  onCancel: () => void;
}) {
  const start = props.draft.plan;
  const [name, setName] = createSignal(props.draft.name);
  const [project, setProject] = createSignal(start.project);
  const [steps, setSteps] = createSignal(start.steps.join("\n"));
  const [output, setOutput] = createSignal(start.output);
  const [kind, setKind] = createSignal<BuildCollect["kind"]>(start.collect.kind);
  const [pattern, setPattern] = createSignal(start.collect.kind === "pattern" ? start.collect.pattern : "*.jar");
  const [saving, setSaving] = createSignal(false);
  const plan = (): BuildPlan => ({
    project: project().trim() || ".", output: output().trim() || ".",
    steps: steps().split("\n").map((s) => s.trim()).filter(Boolean),
    collect: kind() === "pattern" ? { kind: "pattern", pattern: pattern().trim() } : { kind: kind() as "binaries" | "installers" | "zip" },
  });
  const missing = () => (!name().trim() ? "Give it a name." : plan().steps.length === 0 ? "Enter at least one command."
    : kind() === "pattern" && !pattern().trim() ? "Enter a pattern, like *.jar." : "");
  const save = async () => {
    if (missing() || saving()) return;
    setSaving(true);
    try {
      await props.onSave(props.draft.id, name().trim(), plan());
    } finally {
      setSaving(false);
    }
  };
  return (
    // Not a form of its own (the release page is one): Enter in a field saves this instead of publishing.
    <div class="git-build-editor mw-box" role="presentation" onKeyDown={(e) => {
      if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
        e.preventDefault();
        void save();
      }
    }}>
      <label>
        <span>Name</span>
        <input class="mw-input mw-box" value={name()} placeholder="Desktop app" onInput={(e) => setName(e.currentTarget.value)} disabled={props.disabled} />
      </label>
      <label>
        <span>Commands, one per line, run in order</span>
        <textarea class="mw-input mw-box git-command" rows={4} value={steps()} placeholder={"npm ci\nnpm run dist"}
          onInput={(e) => setSteps(e.currentTarget.value)} disabled={props.disabled} />
      </label>
      <div class="git-build-folders">
        <label>
          <span>Runs in (folder of the repository)</span>
          <input class="mw-input mw-box git-command" value={project()} placeholder="." onInput={(e) => setProject(e.currentTarget.value)} disabled={props.disabled} />
        </label>
        <label>
          <span>Files land in (folder of that one)</span>
          <input class="mw-input mw-box git-command" value={output()} placeholder="dist" onInput={(e) => setOutput(e.currentTarget.value)} disabled={props.disabled} />
        </label>
      </div>
      <label>
        <span>Release files</span>
        <Select label="Release files" value={kind()} options={collectOptions} onChange={setKind} disabled={props.disabled} />
      </label>
      <Collapse open={kind() === "pattern"}>
        <label>
          <span>Pattern (* within a folder, **/ through folders)</span>
          <input class="mw-input mw-box git-command" value={pattern()} onInput={(e) => setPattern(e.currentTarget.value)} disabled={props.disabled} />
        </label>
      </Collapse>
      <div class="git-setup-buttons">
        <button class="mw-button mw-box accent" type="button" disabled={props.disabled || saving() || !!missing()} onClick={() => void save()}>
          {saving() ? "Saving..." : props.draft.id === null ? "Save for everyone" : "Save changes"}
        </button>
        <Show when={props.canCancel}>
          <button class="mw-button mw-box" type="button" disabled={saving()} onClick={() => props.onCancel()}>Cancel</button>
        </Show>
        <Show when={missing()}><span class="hint">{missing()}</span></Show>
      </div>
    </div>
  );
}
