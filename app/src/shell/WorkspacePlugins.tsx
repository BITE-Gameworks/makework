import { For, Show, createSignal, onCleanup } from "solid-js";
import { userMessage } from "../api/client";
import { prepareUpload } from "../core/files";
import { can } from "../core/roles";
import { workspaceApi } from "../core/workspaces";
import { parseDeclared, resolveDeclared } from "../system/declared";
import { pluginPackage, plugins, workspaceSettingsSections } from "../plugins/registry";
import { updateWorkspacePlugin } from "../plugins/workspace";
import PluginIcon from "../plugins/PluginIcon";
import type { PluginRecord } from "../plugins/registry";
import type { Row } from "../p2p/permissions";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import Skeleton from "../ui/Skeleton";
import "./WorkspacePlugins.css";

export default function WorkspacePlugins(props: { workspaceId: string }) {
  const [rows, setRows] = createSignal<Row[]>([]);
  const [states, setStates] = createSignal<Row[]>([]);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal("");
  const [removeId, setRemoveId] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const canManage = () => can(props.workspaceId, "manage_plugins");
  let alive = true;
  const refresh = async () => {
    try {
      const api = workspaceApi(props.workspaceId).plugin("channels");
      const [next, nextStates] = await Promise.all([
        api.read("channels_plugins"),
        api.read("channels_plugin_state"),
      ]);
      if (alive) {
        setRows(next);
        setStates(nextStates);
        setError("");
      }
    } catch (e) {
      if (alive) setError(userMessage(e));
    } finally {
      if (alive) setLoading(false);
    }
  };
  const stop = workspaceApi(props.workspaceId).onEvent((event) => {
    if (event.plugin === "channels" && ["channels_plugins", "channels_plugin_state"].includes(event.table)) void refresh();
  });
  onCleanup(() => {
    alive = false;
    stop();
  });
  void refresh();

  const registered = () => new Set(rows().map((row) => String(row.plugin_id)));
  const stateOf = (id: string) => String(states().find((row) => row.plugin_id === id)?.status ?? "enabled");
  const registeredTypes = () => new Set(rows().flatMap((row) => {
    try { return [parseDeclared(String(row.manifest)).name]; }
    catch { return []; }
  }));
  const available = () => plugins().filter((record) =>
    record.origin === "installed" &&
    !!record.plugin.manifest.data &&
    !registered().has(record.plugin.manifest.id) &&
    !registeredTypes().has(record.plugin.manifest.data?.type ?? record.plugin.manifest.contributes?.channelTypes?.[0]?.id ?? ""),
  );
  const add = async (record: PluginRecord) => {
    const manifest = record.plugin.manifest;
    setBusy(manifest.id);
    setError("");
    try {
      const bytes = await pluginPackage(manifest.id);
      if (!bytes) throw new Error("This device doesn't have the plugin package.");
      const file = new File([bytes as BlobPart], `${manifest.id}.mwp`, { type: "application/zip" });
      const upload = await prepareUpload(file);
      await workspaceApi(props.workspaceId).plugin("channels").call("add-plugin", {
        plugin_id: manifest.id,
        version: manifest.version,
        manifest: JSON.stringify(resolveDeclared(record.plugin)),
        package: upload.url,
      });
      await refresh();
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy("");
    }
  };

  const setState = async (id: string, status: "enabled" | "disabled" | "removed") => {
    setBusy(id);
    setError("");
    try {
      await workspaceApi(props.workspaceId).plugin("channels").call("set-plugin-state", { plugin_id: id, status });
      setRemoveId("");
      await refresh();
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy("");
    }
  };

  const update = async (row: Row, file: File) => {
    const id = String(row.plugin_id);
    setBusy(id);
    setError("");
    try {
      await updateWorkspacePlugin(props.workspaceId, row, new Uint8Array(await file.arrayBuffer()));
      await refresh();
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div class="settings-section workspace-plugins">
      <h2>Plugins</h2>
      <p class="hint">
        Plugins are shared by the workspace. Disabling or removing one keeps its channels, data and signed history;
        updates must keep the registered data schema unchanged.
      </p>
      <Show when={error()}><p class="warning">{error()}</p></Show>
      <h3>In this workspace</h3>
      <Show when={rows().length > 0} fallback={loading() ? <Skeleton kind="list" header={false} /> : <p class="hint">No plugins with data are registered.</p>}>
        <ul class="workspace-plugin-list">
          <For each={rows()}>
            {(row) => {
              let declared: ReturnType<typeof parseDeclared> | null = null;
              try { declared = parseDeclared(String(row.manifest)); } catch { declared = null; }
              const local = () => plugins().find((record) => record.plugin.manifest.id === String(row.plugin_id));
              const id = String(row.plugin_id);
              const status = () => stateOf(id);
              let picker!: HTMLInputElement;
              return (
                <li class="workspace-plugin-item mw-box">
                  <PluginIcon manifest={local()?.plugin.manifest} installed={local()?.origin === "installed"} />
                  <div>
                    <strong>{declared?.name ?? String(row.plugin_id)}</strong>
                    <span class="muted"> {String(row.version)}</span>
                    <p class="hint">
                      {id} · {declared ? (local() ? "Installed on this device" : "Not installed on this device") : "Invalid plugin registration"}
                      {status() !== "enabled" ? ` · ${status() === "removed" ? "Removed" : "Disabled"}` : ""}
                    </p>
                    <Show when={status() === "removed"}>
                      <p class="hint">Existing channels and data are retained, but channels cannot be opened or created.</p>
                    </Show>
                  </div>
                  <Show when={canManage()}>
                    <div class="workspace-plugin-actions">
                      <Show when={status() !== "removed"}>
                        <button class="mw-button mw-box" disabled={!!busy()} onClick={() =>
                          void setState(id, status() === "disabled" ? "enabled" : "disabled")}>
                          {busy() === id ? "Saving..." : status() === "disabled" ? "Enable" : "Disable"}
                        </button>
                      </Show>
                      <button class="mw-button mw-box" disabled={!!busy()} onClick={() => picker.click()}>Update from file</button>
                      <input ref={picker} type="file" accept=".mwp" hidden onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file) void update(row, file);
                      }} />
                      <Show when={status() !== "removed"}>
                        <button class="mw-button mw-box" disabled={!!busy()} onClick={() => setRemoveId(id)}>Remove</button>
                      </Show>
                      <Show when={removeId() === id}>
                        <ConfirmPrompt open question={`Remove ${declared?.name ?? id} from this workspace? Its channels, data and history will be kept.`}
                          confirmLabel="Remove" onConfirm={() => void setState(id, "removed")} onCancel={() => setRemoveId("")} />
                      </Show>
                    </div>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <Show when={workspaceSettingsSections().length > 0}>
        <h3>Plugin settings</h3>
        <ul class="workspace-plugin-list">
          <For each={workspaceSettingsSections()}>
            {(section) => (
              <li class="workspace-plugin-item mw-box">
                <PluginIcon manifest={section.record.plugin.manifest} installed={section.record.origin === "installed"} />
                <strong>{section.record.plugin.manifest.name}</strong>
                <div class="workspace-plugin-settings">{section.render({ workspaceId: props.workspaceId })}</div>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={canManage()}>
        <h3>Add installed plugin data</h3>
        <Show when={available().length > 0} fallback={<p class="hint">No unregistered installed plugins with data.</p>}>
          <ul class="workspace-plugin-list">
            <For each={available()}>
              {(record) => {
                const manifest = record.plugin.manifest;
                return (
                  <li class="workspace-plugin-item mw-box">
                    <PluginIcon manifest={manifest} installed />
                    <div>
                      <strong>{manifest.name}</strong>
                      <span class="muted"> {manifest.version}</span>
                      <p class="hint">{manifest.id}</p>
                    </div>
                    <button class="mw-button mw-box" disabled={!!busy()} onClick={() => void add(record)}>
                      {busy() === manifest.id ? "Adding..." : "Add to workspace"}
                    </button>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </Show>
      <Show when={!canManage()}>
        <p class="hint">You need the “Manage plugins” permission to manage plugins in this workspace.</p>
      </Show>
    </div>
  );
}
