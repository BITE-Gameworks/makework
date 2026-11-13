import { For, Show, createSignal, type JSX } from "solid-js";
import { rangeFill } from "../ui/range";
import { ThemeError } from "./parse";
import { colorKeys, soundNames, type BarMode, type ColorKey, type Corners, type SoundName, type Theme } from "./schema";
import {
  deleteUserTheme, duplicateTheme, exportTheme, importTheme, isBuiltIn, saveUserTheme, selectTheme, theme, themes,
} from "./store";
import Select from "../ui/Select";
import ThemePreview from "./ThemePreview";
import { openFile } from "../core/files";
import { Icon, iconSetList } from "./icons";
import { iconPack, setIconPack, setSoundPack, soundPack } from "./packs";
import { playSound, soundPackList } from "./sounds";
import ColorPicker from "../ui/ColorPicker";
import { Switch } from "../ui/Switch";
import { iconThemed, setIconThemed } from "../core/appIcon";
import "./ThemeSettings.css";

const colorLabels: Record<ColorKey, string> = {
  accent: "Accent", accentText: "Text on accent", text: "Text", textMuted: "Muted text",
  textDisabled: "Disabled text", border: "Border", link: "Link", warning: "Warning", success: "Success", danger: "Danger",
  light: "Light", dark: "Dark", darker: "Darker",
};

export default function ThemeSettings() {
  const [error, setError] = createSignal("");
  const editable = () => !isBuiltIn(theme().id);

  const edit = (change: (t: Theme) => void) => {
    const next = structuredClone(theme());
    change(next);
    try {
      saveUserTheme(next);
      setError("");
    } catch (e) {
      setError(e instanceof ThemeError ? e.problems.join(", ") : String(e));
    }
  };

  const importFile = async (file: File) => {
    try {
      selectTheme(importTheme(await file.text()).id);
      setError("");
    } catch (e) {
      setError(e instanceof ThemeError ? e.problems.join(", ") : `Could not read ${file.name}: ${(e as Error).message}`);
    }
  };
  const onImport: JSX.EventHandler<HTMLInputElement, Event> = (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void importFile(file);
  };

  const onExport = () => {
    const url = URL.createObjectURL(new Blob([exportTheme(theme())], { type: "application/json" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `${theme().id}.json` });
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div class="theme-settings">
      <section class="theme-controls">
        <h2>Theme</h2>
        <div class="row">
          <Select label="Theme" value={theme().id} options={themes().map((t) => ({ value: t.id, label: t.name }))} onChange={selectTheme} />
        </div>
        <div class="row">
          <button class="mw-button mw-box" onClick={() => selectTheme(duplicateTheme(theme().id).id)}>Duplicate</button>
          <label class="mw-button mw-box">
            Import<input type="file" accept=".json,application/json" hidden onChange={onImport} />
          </label>
          <button class="mw-button mw-box" onClick={onExport}>Export</button>
          <Show when={editable()}>
            <button class="mw-button mw-box" onClick={() => deleteUserTheme(theme().id)}>Delete</button>
          </Show>
        </div>
        <div class="row">
          <Switch checked={iconThemed()} onChange={setIconThemed} label="Icon matches theme colors"
            title="The app's icon (taskbar, tab) takes the theme's colors" />
        </div>
        <Show when={error()}>
          <p class="theme-error">{error()}</p>
        </Show>
        <Show when={editable()} fallback={<p class="hint">Built-in theme. Duplicate it to make changes.</p>}>
          <ThemeEditor theme={theme()} edit={edit} />
        </Show>
        <Packs />
      </section>
      <ThemePreview colorLabels={colorLabels} />
    </div>
  );
}

// Icons and sounds, chosen apart from the theme (theme/packs.ts), with a sample of each.
const sampleIcons = ["channel-chat", "channel-voice", "channel-files", "channel-tasks", "channel-design", "settings", "search",
  "add", "profile", "lock", "mic", "headset", "camera", "screen-share", "attach", "send", "pin", "delete"] as const;
const soundLabels: Record<SoundName, string> = {
  mention: "Mention", notification: "Notification", join: "Join call", leave: "Leave call", "peer-join": "Someone joins", "peer-leave": "Someone leaves",
  mute: "Mute", unmute: "Unmute", deafen: "Deafen", undeafen: "Undeafen", "stream-start": "Stream starts",
  "stream-stop": "Stream stops", disconnect: "Disconnected", "task-done": "Task done", "upload-done": "Upload done", error: "Error",
};

// CREDITS.md (app/, made by scripts/credits.mjs) in the file viewer, over the settings.
async function showCredits() {
  const { default: text } = await import("../../CREDITS.md?raw");
  const blob = new Blob([text], { type: "text/markdown" });
  openFile({ name: "CREDITS.md", mimeType: "text/markdown", size: blob.size, read: () => Promise.resolve(blob) });
}

function Packs() {
  return (
    <>
      <h2>Icon pack</h2>
      <div class="row">
        <Select label="Icon pack" value={iconPack()} onChange={setIconPack}
          options={[{ value: "theme", label: "From the theme" }, ...iconSetList().map((p) => ({ value: p.id, label: p.name }))]} />
      </div>
      <Show when={iconSetList().find((p) => p.id === (iconPack() === "theme" ? theme().icons.set : iconPack()))?.credit}>
        {(credit) => <p class="hint">Icons: {credit()}</p>}
      </Show>
      <div class="pack-icons mw-box">
        <For each={sampleIcons}>{(name) => <Icon name={name} size={22} label={name} />}</For>
      </div>
      <h2>Sound pack</h2>
      <div class="row">
        <Select label="Sound pack" value={soundPack()} onChange={setSoundPack}
          options={[{ value: "theme", label: "From the theme" }, ...soundPackList().map((p) => ({ value: p.id, label: p.name }))]} />
      </div>
      <div class="row">
        <For each={soundNames}>
          {(name) => (
            <button class="mw-button mw-box" onClick={() => playSound(name)}><Icon name="play" size={14} /> {soundLabels[name]}</button>
          )}
        </For>
      </div>
      <p class="hint">Sound volume is in Settings &gt; Audio.</p>
      <h2>Credits</h2>
      <p class="hint">The people behind the icons, fonts, sounds and libraries MakeWork uses, with their licenses.</p>
      <div class="row">
        <button class="mw-button mw-box" onClick={() => void showCredits()}><Icon name="info" /> Credits</button>
      </div>
    </>
  );
}

function ThemeEditor(props: { theme: Theme; edit: (change: (t: Theme) => void) => void }) {

  return (
    <div class="theme-editor">
      <Field label="Name">
        <input class="mw-input mw-box" value={props.theme.name} onChange={(e) => props.edit((t) => (t.name = e.currentTarget.value))} />
      </Field>

      <h3>Colors</h3>
      <div class="color-grid">
        <For each={colorKeys}>
          {(key) => (
            <div class="color-field">
              <ColorPicker class="theme-color-picker" value={toHex(props.theme.colors[key])} label={`${colorLabels[key]} color`}
                onPreview={(color) => props.edit((t) => (t.colors[key] = color))}
                onPick={(color) => props.edit((t) => (t.colors[key] = color))} />
              <span>{colorLabels[key]}</span>
            </div>
          )}
        </For>
      </div>

      <h3>Shape</h3>
      <Field label="Corners">
        <Select<Corners> label="Corners" value={props.theme.shape.corners}
          options={[{ value: "rounded", label: "Rounded" }, { value: "square", label: "Square" }, { value: "cut", label: "Cut" }]}
          onChange={(v) => props.edit((t) => (t.shape.corners = v))} />
      </Field>
      <Field label={`Corner size ${props.theme.shape.size}px`}>
        <input type="range" min="0" max="24" value={props.theme.shape.size} style={rangeFill(props.theme.shape.size, 0, 24)}
          onInput={(e) => props.edit((t) => (t.shape.size = Number(e.currentTarget.value)))} />
      </Field>
      <Field label={`Border width ${props.theme.border.width}px`}>
        <input type="range" min="0" max="8" value={props.theme.border.width} style={rangeFill(props.theme.border.width, 0, 8)}
          onInput={(e) => props.edit((t) => (t.border.width = Number(e.currentTarget.value)))} />
      </Field>
      <Field label="Outline boxes and panels">
        <input type="checkbox" checked={props.theme.border.outlines === true}
          onChange={(e) => props.edit((t) => (t.border.outlines = e.currentTarget.checked))} />
      </Field>

      <h3>Fonts</h3>
      <Field label="Interface font">
        <input class="mw-input mw-box" value={props.theme.fonts.ui} onChange={(e) => props.edit((t) => (t.fonts.ui = e.currentTarget.value))} />
      </Field>
      <Field label="Code font">
        <input class="mw-input mw-box" value={props.theme.fonts.code} onChange={(e) => props.edit((t) => (t.fonts.code = e.currentTarget.value))} />
      </Field>
      <Field label="Headings">
        <input class="mw-input mw-box" value={props.theme.fonts.heading ?? props.theme.fonts.ui} onChange={(e) => props.edit((t) => (t.fonts.heading = e.currentTarget.value))} />
      </Field>
      <Field label={`Size ${props.theme.fonts.size}px`}>
        <input type="range" min="10" max="24" value={props.theme.fonts.size} style={rangeFill(props.theme.fonts.size, 10, 24)}
          onInput={(e) => props.edit((t) => (t.fonts.size = Number(e.currentTarget.value)))} />
      </Field>

      <h3>Layout</h3>
      <For each={[["serverBar", "Workspace bar", 40, 120], ["channelBar", "Channel bar", 160, 480]] as const}>
        {([bar, label, min, max]) => (
          <>
            <Field label={`${label} ${props.theme.layout[bar].width}px`}>
              <input type="range" min={min} max={max} value={props.theme.layout[bar].width}
                style={rangeFill(props.theme.layout[bar].width, min, max)}
                onInput={(e) => props.edit((t) => (t.layout[bar].width = Number(e.currentTarget.value)))} />
            </Field>
            <Field label={`${label} style`}>
              <Select<BarMode> label={`${label} style`} value={props.theme.layout[bar].mode}
                options={[{ value: "docked", label: "Docked" }, { value: "floating", label: "Floating" }]}
                onChange={(v) => props.edit((t) => (t.layout[bar].mode = v))} />
            </Field>
          </>
        )}
      </For>
      <Field label={`Gap ${props.theme.layout.gap}px`}>
        <input type="range" min="0" max="32" value={props.theme.layout.gap} style={rangeFill(props.theme.layout.gap, 0, 32)}
          onInput={(e) => props.edit((t) => (t.layout.gap = Number(e.currentTarget.value)))} />
      </Field>
      <Field label={`Margin ${props.theme.layout.margin}px`}>
        <input type="range" min="0" max="48" value={props.theme.layout.margin} style={rangeFill(props.theme.layout.margin, 0, 48)}
          onInput={(e) => props.edit((t) => (t.layout.margin = Number(e.currentTarget.value)))} />
      </Field>
    </div>
  );
}

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

// <input type="color"> only takes #rrggbb.
function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((c) => c + c).join("")}`;
  if (/^#[0-9a-f]{8}$/i.test(color)) return color.slice(0, 7);
  return "#000000";
}
