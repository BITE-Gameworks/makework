import { For, Match, Show, Switch as Pick, createResource, createSignal } from "solid-js";
import { userMessage } from "../api/client";
import { desktop } from "../core/desktop";
import { tokenStorage } from "../core/secrets";
import Combobox from "../ui/Combobox";
import Select from "../ui/Select";
import { Switch } from "../ui/Switch";
import { pluginSecret, pluginSetting, secretVersion, setPluginSecret, setPluginSetting } from "./settings";
import type { PluginSetting } from "./types";

// A plugin's settings (ClientPlugin.settings) under its card in Settings > Plugins.
export default function PluginSettingsForm(props: { pluginId: string; settings: PluginSetting[] }) {
  const value = (key: string) => pluginSetting(props.pluginId, key);
  const set = (key: string, next: unknown) => setPluginSetting(props.pluginId, key, next);
  const secret = (key: string) => pluginSecret(props.pluginId, key);
  const shown = (setting: PluginSetting) => (!setting.desktop || !!desktop) && (!setting.when || setting.when(value));
  return (
    <div class="plugin-settings-form">
      <For each={props.settings}>{(setting) =>
        <Show when={shown(setting)}>
          <Pick>
            <Match when={setting.type === "heading"}><h4 class="plugin-settings-heading">{setting.label}</h4></Match>
            <Match when={setting.type === "custom"}>
              <div class="plugin-setting account-field">
                <span>{setting.label}</span>
                {(setting as PluginSetting & { type: "custom" }).render()}
                <Show when={setting.hint}><p class="hint">{setting.hint}</p></Show>
              </div>
            </Match>
            <Match when={setting.type === "toggle"}>
              <div class="plugin-setting">
                <Switch checked={value(setting.key) === true} onChange={(on) => set(setting.key, on)} label={setting.label} />
                <Show when={setting.hint}><p class="hint">{setting.hint}</p></Show>
              </div>
            </Match>
            <Match when={true}>
              <label class="plugin-setting account-field">
                <span>{setting.label}</span>
                <Field setting={setting} pluginId={props.pluginId} value={value} set={set} secret={secret} />
                <Show when={setting.hint}><p class="hint">{setting.hint}</p></Show>
              </label>
            </Match>
          </Pick>
        </Show>
      }</For>
    </div>
  );
}

function Field(props: {
  setting: PluginSetting;
  pluginId: string;
  value: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  secret: (key: string) => Promise<string | null>;
}) {
  const s = props.setting;
  const text = () => String(props.value(s.key) ?? "");
  switch (s.type) {
    case "number":
      return <input class="mw-input mw-box" type="number" min={s.min} max={s.max} value={text()}
        onChange={(e) => props.set(s.key, e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value))} />;
    case "select":
      return <Select label={s.label} options={s.options} value={text()} onChange={(next) => props.set(s.key, next)} />;
    case "secret":
      return <SecretField pluginId={props.pluginId} setting={s} />;
    case "suggest": {
      const [options] = createResource(
        () => [secretVersion(), ...(s.dependsOn ?? []).map((key) => props.value(key))].join("|"),
        () => s.suggest(props.value, props.secret).catch(() => null));
      return <>
        <Combobox label={s.label} placeholder={s.placeholder} value={text()} suggestions={options() ?? []} onCommit={(next) => props.set(s.key, next.trim() || undefined)} />
        <Show when={options() === null}><span class="hint">No list could be fetched. You can still type a name.</span></Show>
      </>;
    }
    default:
      return <input class="mw-input mw-box" type="text" placeholder={"placeholder" in s ? s.placeholder : undefined} value={text()}
        onChange={(e) => props.set(s.key, e.currentTarget.value.trim() || undefined)} />;
  }
}

function SecretField(props: { pluginId: string; setting: PluginSetting & { type: "secret" } }) {
  const [saved, { refetch }] = createResource(() => secretVersion() + 1, () => pluginSecret(props.pluginId, props.setting.key).then((v) => !!v));
  const [storage] = createResource(tokenStorage);
  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal("");
  const save = async (next: string | null) => {
    setError("");
    try {
      await setPluginSecret(props.pluginId, props.setting.key, next);
      setDraft("");
      void refetch();
    } catch (e) {
      setError(userMessage(e));
    }
  };
  return <>
    <div class="plugin-secret">
      <input class="mw-input mw-box" type="password" autocomplete="off" value={draft()}
        placeholder={saved() ? "Saved. Type to replace it." : props.setting.placeholder}
        onInput={(e) => setDraft(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && draft().trim() && void save(draft().trim())} />
      <button type="button" class="mw-button mw-box" disabled={!draft().trim()} onClick={() => void save(draft().trim())}>Save</button>
      <Show when={saved()}><button type="button" class="mw-button mw-box" onClick={() => void save(null)}>Forget</button></Show>
    </div>
    <Show when={storage() === "plain"}><span class="hint">This browser keeps it unencrypted.</span></Show>
    <Show when={storage() === "none"}><span class="hint warning">No system keychain was found, so it can't be kept.</span></Show>
    <Show when={error()}><span class="hint warning">{error()}</span></Show>
  </>;
}
