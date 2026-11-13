import { For, Show, createSignal, type JSX } from "solid-js";
import { installPlugin, isEnabled, loadErrors, plugins, setEnabled, uninstallPlugin, updatePlugin } from "./registry";
import { userMessage } from "../api/client";
import { Switch } from "../ui/Switch";
import { createFileDrop, DropHint } from "../ui/FileDrop";
import type { PluginManifest } from "./types";
import PluginIcon from "./PluginIcon";
import PluginSettingsForm from "./PluginSettingsForm";
import Collapse from "../ui/Collapse";
import Disclosure from "../ui/Disclosure";
import "./PluginSettings.css";

export default function PluginSettings() {
  const [message, setMessage] = createSignal<{ ok: boolean; text: string } | null>(null);

  const installFile = async (file: File) => {
    try {
      const manifest = await installPlugin(await file.arrayBuffer());
      setMessage({ ok: true, text: `Installed ${manifest.name} ${manifest.version}.` });
    } catch (e) {
      setMessage({ ok: false, text: `Could not install ${file.name}: ${userMessage(e)}` });
    }
  };
  const drop = createFileDrop((data) => {
    const file = [...data.files].find((candidate) => candidate.name.toLowerCase().endsWith(".mwp"));
    if (file) void installFile(file);
    else setMessage({ ok: false, text: "Drop a .mwp plugin package to install it." });
  });

  const onInstall: JSX.EventHandler<HTMLInputElement, Event> = (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void installFile(file);
  };

  return (
    <div class="plugin-settings" {...drop.on}>
      <DropHint show={drop.over()} label="Drop a .mwp plugin package to install" />
      <div class="plugin-toolbar">
        <h2>Plugins</h2>
        <label class="mw-button primary mw-box">
          Install from file<input type="file" accept=".mwp" hidden onChange={onInstall} />
        </label>
      </div>
      <p class="hint">
        Plugins installed here run inside the app with full access, like any program you install.
        Only install plugins you trust. Views that a workspace sends always run sandboxed.
      </p>
      <Show when={message()}>{(m) => <p classList={{ warning: !m().ok }}>{m().text}</p>}</Show>
      <For each={loadErrors()}>{(error) => <p class="warning">Not loaded: {error}</p>}</For>

      <PluginSection title="Built in" records={plugins().filter((r) => r.origin === "built-in")} />
      <PluginSection class="plugin-installed" title="Installed" records={plugins().filter((r) => r.origin === "installed")}
        onUpdate={async (id, file) => {
          const manifest = await updatePlugin(id, await file.arrayBuffer());
          setMessage({ ok: true, text: `Updated ${manifest.name} to ${manifest.version}.` });
        }}
        onError={(file, error) => setMessage({ ok: false, text: `Could not update ${file.name}: ${userMessage(error)}` })} />
    </div>
  );
}

function PluginSection(props: {
  class?: string;
  title: string;
  records: ReturnType<typeof plugins>;
  onUpdate?: (id: string, file: File) => Promise<void>;
  onError?: (file: File, error: unknown) => void;
}) {
  return (
    <section class={`plugin-section ${props.class ?? ""}`}>
      <h3 class="plugin-section-title">{props.title}</h3>
      <ul class="plugin-list">
        <For each={props.records}>
          {(record) => {
            const m = record.plugin.manifest;
            let picker!: HTMLInputElement;
            const [settingsOpen, setSettingsOpen] = createSignal(false);
            return (
              <li class="plugin-card mw-box" classList={{ disabled: !isEnabled(m.id) }}>
                <PluginIcon manifest={m} installed={record.origin === "installed"} />
                <div class="plugin-info">
                  <h3>{m.name} <span class="muted">{m.version}</span></h3>
                  <p class="muted">{m.id}{m.author ? ` by ${m.author}` : ""}</p>
                  <Show when={m.description}><p>{m.description}</p></Show>
                  <p class="muted">{contributions(m, record.plugin.channelViews)}</p>
                </div>
                <div class="plugin-actions">
                  <Switch checked={isEnabled(m.id)} onChange={(on) => setEnabled(m.id, on)} label="Enabled" />
                  <Show when={record.origin === "installed"}>
                    <Show when={props.onUpdate}>
                      <button class="mw-button mw-box" onClick={() => picker.click()}>Update from file</button>
                      <input ref={picker} type="file" accept=".mwp" hidden onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file && props.onUpdate) void props.onUpdate(m.id, file).catch((error) => props.onError?.(file, error));
                      }} />
                    </Show>
                    <button class="mw-button mw-box" onClick={() => uninstallPlugin(m.id)}>Remove</button>
                  </Show>
                  <Show when={record.plugin.settings?.length}>
                    <Disclosure class="plugin-settings-toggle" open={settingsOpen()} onToggle={() => setSettingsOpen(!settingsOpen())}>Settings</Disclosure>
                  </Show>
                </div>
                <Show when={record.plugin.settings?.length}>
                  <div class="plugin-card-settings">
                    <Collapse open={settingsOpen()}>
                      <PluginSettingsForm pluginId={m.id} settings={record.plugin.settings!} />
                    </Collapse>
                  </div>
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
    </section>
  );
}

function contributions(m: PluginManifest, views: Record<string, unknown> | undefined): string {
  const parts: string[] = [];
  const c = m.contributes ?? {};
  if (c.channelTypes?.length) parts.push(`channel types: ${c.channelTypes.map((t) => t.id).join(", ")}`);
  if (views && Object.keys(views).length) parts.push(`views: ${Object.keys(views).join(", ")}`);
  if (c.viewers?.length) parts.push(`file viewers: ${c.viewers.map((v) => v.label).join(", ")}`);
  if (c.themes?.length) parts.push(`themes: ${c.themes.map((t) => t.name).join(", ")}`);
  if (c.iconSets) parts.push(`icon sets: ${Object.keys(c.iconSets).join(", ")}`);
  return parts.join("; ");
}