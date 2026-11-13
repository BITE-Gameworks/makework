// Plugins' own settings (ClientPlugin.settings), kept on this device. Secrets go to the keychain through
// core/secrets (desktop), or the browser's storage.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { forgetToken, getToken, setToken } from "../core/secrets";
import { readJson, writeJson } from "../core/storage";
import { plugins } from "./registry";
import type { PluginSetting } from "./types";

const storeKey = "mw.pluginSettings";
const [values, setValues] = createStore<Record<string, Record<string, unknown>>>(readJson(storeKey, {}));
const [secretChanges, setSecretChanges] = createSignal(0);

export const declaredSettings = (pluginId: string): PluginSetting[] =>
  plugins().find((record) => record.plugin.manifest.id === pluginId)?.plugin.settings ?? [];

export function pluginSetting(pluginId: string, key: string): unknown {
  const value = values[pluginId]?.[key];
  if (value !== undefined) return value;
  const declared = declaredSettings(pluginId).find((setting) => setting.key === key);
  return declared && "default" in declared ? declared.default : undefined;
}

export function setPluginSetting(pluginId: string, key: string, value: unknown): void {
  setValues(pluginId, (old) => ({ ...old, [key]: value }));
  writeJson(storeKey, values);
}

const secretHost = (pluginId: string, key: string) => `plugin:${pluginId}:${key}`;
// Reactive: changes when a secret is saved or forgotten, so fields that use it ask again.
export const secretVersion = secretChanges;
export const pluginSecret = (pluginId: string, key: string) => getToken(secretHost(pluginId, key));
export async function setPluginSecret(pluginId: string, key: string, value: string | null): Promise<void> {
  if (value) await setToken(secretHost(pluginId, key), value);
  else await forgetToken(secretHost(pluginId, key));
  setSecretChanges((n) => n + 1);
}
