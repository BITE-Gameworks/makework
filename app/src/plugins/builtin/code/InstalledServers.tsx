// Settings > Plugins > Code: the language servers the app can download, the space each takes, install and uninstall.
import { For, Show, createResource, createSignal } from "solid-js";
import { userMessage } from "../../../api/client";
import { desktop, desktopError } from "../../../core/desktop";
import { formatBytes } from "../../../core/time";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import Skeleton from "../../../ui/Skeleton";
import "./InstalledServers.css";

export default function InstalledServers() {
  const [servers, { refetch }] = createResource(() => desktop?.code?.installedServers() ?? Promise.resolve([]));
  const [busy, setBusy] = createSignal<string | null>(null);
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const act = async (id: string, task: Promise<void>) => {
    setBusy(id);
    setError("");
    try {
      await task;
    } catch (e) {
      setError(userMessage(desktopError(e)));
    }
    setBusy(null);
    void refetch();
  };
  return (
    <Show when={servers()} fallback={<Skeleton kind="line" />}>
      <ul class="code-servers">
        <For each={servers()}>{(server) => {
          const working = () => busy() === server.id || server.installing;
          const name = () => server.found?.split(/[\\/]/).pop();
          return (
            <li>
              <div class="code-server-row">
                <span class="code-server-name">{server.label}</span>
                <span class="code-server-state">
                  {working() ? (server.size === null ? "Installing..." : "Removing...")
                    : server.size !== null ? formatBytes(server.size) : server.found ? `Uses ${name()} on this computer` : "Not installed"}
                </span>
                <Show when={working()}><span class="mw-spinner" /></Show>
                <Show when={!working() && server.size !== null}>
                  <button type="button" class="mw-button mw-box" onClick={() => setConfirming(server.id)}>Uninstall</button>
                </Show>
                <Show when={!working() && server.size === null && !server.found}>
                  <button type="button" class="mw-button mw-box" title={`Downloads ${server.from}`}
                    onClick={() => void act(server.id, desktop!.code!.installServer(server.id))}>Install</button>
                </Show>
              </div>
              <Show when={server.size !== null && server.found}>
                <p class="hint">{name()} on this computer is used before this one.</p>
              </Show>
              <ConfirmPrompt open={confirming() === server.id} question={`Remove the ${server.label} language server the app downloaded?`}
                confirmLabel="Uninstall" onCancel={() => setConfirming(null)}
                onConfirm={() => {
                  setConfirming(null);
                  void act(server.id, desktop!.code!.uninstallServer(server.id));
                }} />
            </li>
          );
        }}</For>
      </ul>
      <Show when={error()}><p class="hint warning">{error()}</p></Show>
    </Show>
  );
}
