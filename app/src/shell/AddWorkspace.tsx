// The workspace bar's add button: create a serverless workspace or join one with an invite code. On desktop, where the
// server is kept on this computer: the app's data (default) or a folder of its own; or import a workspace's folder.
import { Show, createSignal } from "solid-js";
import { account } from "../core/account";
import { desktop, desktopError } from "../core/desktop";
import { createServerless, importServerless, joinServerless } from "../core/serverless";
import { parseInvite, type ExistingFolder, type Folder } from "../p2p/workspaces";
import { importExplorePreset } from "../core/explorePreset";
import { Icon } from "../theme/icons";
import Collapse from "../ui/Collapse";
import Popover from "../ui/Popover";

export default function AddWorkspace() {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="add-workspace">
      <button class="workspace-button add mw-box" title="Add a workspace" aria-label="Add a workspace" aria-expanded={open()}
        onClick={() => setOpen(!open())}>
        <Icon name="add" />
      </button>
      <Popover open={open()} onClose={() => setOpen(false)} label="Add a workspace" placement="below">
        <AddWorkspaceForms onDone={() => setOpen(false)} />
      </Popover>
    </div>
  );
}

// Create, join with an invite, or (desktop) open a saved server folder: in the + popover and on the start page.
export function AddWorkspaceForms(props: { onDone?: () => void }) {
  const [name, setName] = createSignal("");
  const [code, setCode] = createSignal("");
  const [folder, setFolder] = createSignal<Folder | null>(null);
  // A picked server folder without a saved secret waits here for its invite code.
  const [importing, setImporting] = createSignal<ExistingFolder | null>(null);
  const [importCode, setImportCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const offline = () => account()?.offline === true;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      setName("");
      setCode("");
      setFolder(null);
      setImporting(null);
      setImportCode("");
      props.onDone?.();
    } catch (e) {
      setError(desktopError(e).message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  // A folder that already holds the workspace being joined is fine, so the invite's id goes along when there is one.
  const chooseFolder = async () => {
    setError("");
    try {
      const picked = await desktop!.storage!.pick(parseInvite(code())?.id);
      if (picked) setFolder(picked);
    } catch (e) {
      setError(desktopError(e).message);
    }
  };

  const chooseImport = async () => {
    setError("");
    try {
      const picked = await desktop!.storage!.pickExisting();
      if (!picked) return;
      if (picked.secret) void run(() => importServerless(picked));
      else setImporting(picked);
    } catch (e) {
      setError(desktopError(e).message);
    }
  };

  return (
    <div class="add-workspace-panel">
      <form onSubmit={(e) => {
        e.preventDefault();
        if (name().trim()) void run(() => createServerless(name().trim(), folder() ?? undefined));
      }}>
        <h3>Create a workspace</h3>
        <p class="hint">A new place for your group. Free, with nothing to set up.</p>
        <div class="add-workspace-row">
          <input class="mw-input mw-box" placeholder="Workspace name" maxLength={48} value={name()}
            onInput={(e) => setName(e.currentTarget.value)} />
          <button class="mw-button primary mw-box" type="submit" disabled={busy() || !name().trim()}>Create</button>
        </div>
      </form>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(() => importExplorePreset(folder() ?? undefined));
      }}>
        <h3>Explore MakeWork</h3>
        <p class="hint">Try chat, tasks and docs in a ready-made workspace.</p>
        <button class="mw-button mw-box" type="submit" disabled={busy()}>Make it</button>
      </form>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (code().trim()) void run(() => joinServerless(code(), folder() ?? undefined));
      }}>
        <h3>Join a workspace</h3>
        <Show when={!offline()} fallback={
          <p class="hint">Create an account to share workspaces: joining one needs the user server so its members can find you.</p>
        }>
          <div class="add-workspace-row">
            <input class="mw-input mw-box" placeholder="Invite code" spellcheck={false} value={code()}
              onInput={(e) => setCode(e.currentTarget.value)} />
            <button class="mw-button mw-box" type="submit" disabled={busy() || !code().trim()}>Join</button>
          </div>
        </Show>
      </form>
      <Show when={desktop?.storage}>
        <div class="add-workspace-storage">
          <Icon name="folder" />
          <span class="where" title={folder()?.folder ?? "Kept inside MakeWork"}>
            Saved {folder() ? <>in <strong>{baseName(folder()!.folder)}</strong></> : "inside MakeWork"}
          </span>
          <Show when={folder()} fallback={
            <button class="mw-button mw-box" type="button" disabled={busy()} onClick={() => void chooseFolder()}>Save in a folder...</button>
          }>
            <button class="mw-button mw-box" type="button" disabled={busy()} onClick={() => setFolder(null)}>Save inside MakeWork</button>
          </Show>
        </div>
        <form onSubmit={(e) => {
          e.preventDefault();
          const picked = importing();
          if (picked && importCode().trim()) void run(() => importServerless(picked, importCode()));
        }}>
          <h3>Open a saved workspace</h3>
          <p class="hint">Bring back a workspace you left, or one copied from another computer.</p>
          <Show when={importing()} fallback={
            <button class="mw-button mw-box" type="button" disabled={busy()} onClick={() => void chooseImport()}>
              <Icon name="folder" /> Open workspace folder...
            </button>
          }>
            {(picked) => (
              <>
                <p class="hint">To open {picked().name || baseName(picked().folder)}, paste its invite code.</p>
                <div class="add-workspace-row">
                  <input class="mw-input mw-box" placeholder="Invite code" spellcheck={false} value={importCode()}
                    onInput={(e) => setImportCode(e.currentTarget.value)} />
                  <button class="mw-button mw-box" type="submit" disabled={busy() || !importCode().trim()}>Open</button>
                </div>
              </>
            )}
          </Show>
        </form>
      </Show>
      <Collapse open={error() !== ""}>
        <p class="add-workspace-error" role="alert">{error()}</p>
      </Collapse>
    </div>
  );
}

const baseName = (folder: string) => folder.split(/[/\\]/).findLast(Boolean) ?? folder;
