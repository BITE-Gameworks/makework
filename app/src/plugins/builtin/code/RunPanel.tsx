// The channel's run configurations: a name and a shell command each, shared with every member. Others' devices
// ask before running a command after it was changed.
import { For, Show, createSignal } from "solid-js";
import { userMessage } from "../../../api/client";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import type { RunConfig } from "./runs";

export default function RunPanel(props: {
  runs: () => RunConfig[];
  canEdit: () => boolean;
  who: (userId: number) => string;
  approved: (run: RunConfig) => boolean;
  onAdd: (name: string, command: string) => Promise<void>;
  onSave: (run: RunConfig, name: string, command: string) => Promise<void>;
  onRemove: (run: RunConfig) => Promise<void>;
  onRun: (run: RunConfig) => void;
}) {
  const [error, setError] = createSignal("");
  const [removing, setRemoving] = createSignal<number | null>(null);
  const attempt = async (action: () => Promise<void>) => {
    setError("");
    try { await action(); } catch (e) { setError(userMessage(e)); }
  };
  let newName!: HTMLInputElement;
  let newCommand!: HTMLTextAreaElement;
  const add = () => attempt(async () => {
    await props.onAdd(newName.value.trim(), newCommand.value.trim());
    newName.value = "";
    newCommand.value = "";
  });
  return (
    <div class="code-find code-runs">
      <p class="code-find-note">Commands run in your own copy of the channel's files on this computer. Your computer asks before running a command someone else wrote or changed.</p>
      <div class="code-find-results mw-scroll-fade">
        <For each={props.runs()}>{(run) => {
          let name!: HTMLInputElement;
          let command!: HTMLTextAreaElement;
          const save = () => {
            const n = name.value.trim(), c = command.value.trim();
            if (n !== run.name || c !== run.command) void attempt(() => props.onSave(run, n, c));
          };
          return (
            <div class="code-run-item mw-box">
              <input ref={name} class="mw-input mw-box" value={run.name} disabled={!props.canEdit()} aria-label="Name" onChange={save} />
              <textarea ref={command} class="mw-input mw-box code-run-command" value={run.command} disabled={!props.canEdit()} rows={2} aria-label="Command"
                onChange={save} />
              <span class="hint">Last changed by {props.who(run.updatedBy)}{props.approved(run) ? "" : " · not run on this computer yet"}</span>
              <div class="code-run-actions">
                <button class="mw-button mw-box" onClick={() => props.onRun(run)}>Run</button>
                <Show when={props.canEdit()}><button class="mw-button mw-box" onClick={() => setRemoving(run.id)}>Remove</button></Show>
              </div>
              <ConfirmPrompt open={removing() === run.id} question={`Remove ${run.name} for everyone?`} confirmLabel="Remove"
                onConfirm={() => { setRemoving(null); void attempt(() => props.onRemove(run)); }} onCancel={() => setRemoving(null)} />
            </div>
          );
        }}</For>
        <Show when={props.canEdit()}>
          <div class="code-run-item mw-box">
            <input ref={newName} class="mw-input mw-box" placeholder="Name, e.g. Tests" aria-label="New configuration name" />
            <textarea ref={newCommand} class="mw-input mw-box code-run-command" rows={2} placeholder="Command, e.g. npm test" aria-label="New configuration command" />
            <div class="code-run-actions"><button class="mw-button primary mw-box" onClick={() => void add()}>Add</button></div>
          </div>
        </Show>
        <Show when={error()}><p class="code-find-note warning">{error()}</p></Show>
      </div>
    </div>
  );
}
