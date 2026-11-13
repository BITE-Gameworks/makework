// Settings > Plugins > Version control: this member's host connections on this computer (connections.ts), renamed
// in place and forgotten after a confirm. They are added from a channel, where the link says which host one is for.
// (Not "Connections.tsx": next to connections.ts, Windows and macOS would load one for the other.)
import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { userMessage } from "../../../api/client";
import { desktopError } from "../../../core/desktop";
import { githubRevision } from "../../../core/githubAuth";
import { tokenRevision, tokenStorage } from "../../../core/secrets";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import Skeleton from "../../../ui/Skeleton";
import { allConnections, connectionRevision, connectionUses, forgetConnection, renameConnection, type Connection } from "./connections";
import "./ConnectionSettings.css";

const channels = (n: number) => `${n} channel${n === 1 ? "" : "s"}`;

export default function ConnectionSettings() {
  const [list] = createResource(() => connectionRevision() + tokenRevision() + githubRevision(), () => allConnections());
  // Kept by key, so a rename or a pick doesn't remount the rows (and the name field being typed in).
  const [items, setItems] = createStore<Connection[]>([]);
  createEffect(() => list.latest && setItems(reconcile(list.latest, { key: "key" })));
  // Counted once per change, not per row.
  const uses = createMemo(() => { connectionRevision(); return connectionUses(); });
  const used = (key: string) => uses().get(key) ?? 0;
  const [storage] = createResource(tokenStorage);
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const question = (c: Connection) => [
    `Forget ${c.name}?`,
    c.key === "github.com" ? "This signs you out of GitHub here." : "",
    used(c.key) ? `${channels(used(c.key))} here use it and will ask for another.` : "",
  ].filter(Boolean).join(" ");
  const forget = async (c: Connection) => {
    setConfirming(null);
    setError("");
    try {
      await forgetConnection(c.key);
    } catch (e) {
      setError(`${c.name} couldn't be forgotten: ${userMessage(desktopError(e))}`);
    }
  };

  return (
    <Show when={list.latest} fallback={<Skeleton kind="line" />}>
      <Show when={items.length} fallback={<p class="hint">None yet. A version control channel asks for one when its repository is private.</p>}>
        <ul class="git-connections">
          <For each={items}>{(c) => (
            <li>
              <div class="git-connection-row">
                <Icon name="lock" />
                <input class="mw-input mw-box git-connection-name" value={c.name} aria-label={`Name of ${c.name}`}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  onChange={(e) => {
                    if (e.currentTarget.value.trim()) renameConnection(c.key, e.currentTarget.value);
                    else e.currentTarget.value = c.name;
                  }} />
                <span class="git-connection-host">
                  {c.host}<Show when={used(c.key)}>{` · ${channels(used(c.key))} here`}</Show>
                </span>
                <button type="button" class="mw-button mw-box" onClick={() => setConfirming(confirming() === c.key ? null : c.key)}>Forget</button>
              </div>
              <ConfirmPrompt open={confirming() === c.key} question={question(c)} confirmLabel="Forget"
                onCancel={() => setConfirming(null)} onConfirm={() => void forget(c)} />
            </li>
          )}</For>
        </ul>
      </Show>
      <Collapse open={!!error()}><p class="hint warning">{error()}</p></Collapse>
      <p class="hint">
        {storage() === "plain" ? "Kept in this browser, not encrypted." : storage() === "none"
          ? "This system has no keychain, so tokens can't be kept here." : "Kept on this computer, encrypted with the system keychain."}
        {" "}Each token is only sent to its host.
      </p>
    </Show>
  );
}
