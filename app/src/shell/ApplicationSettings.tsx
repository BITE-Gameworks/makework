import { Show, createResource } from "solid-js";
import { desktop, desktopError, type BackgroundSettings, type GpuChoice } from "../core/desktop";
import { powerSavingChoice, setPowerSavingChoice, type PowerSavingChoice } from "../core/power";
import { ghostThresholdMb, setGhostThresholdMb } from "../core/ui";
import Select from "../ui/Select";

// Settings > Application: downloads, power saving, and on desktop what closing the window does, starting with the
// computer and the graphics card.
export default function ApplicationSettings() {
  return (
    <div class="settings-section">
      <h2>Application</h2>
      <h3>Files</h3>
      <label class="settings-field">
        <span>Download automatically up to</span>
        <input class="mw-input mw-box" type="number" min="0" step="1" value={ghostThresholdMb()}
          onChange={(e) => setGhostThresholdMb(Number(e.currentTarget.value) || 0)} />
        <span>MB</span>
      </label>
      <p class="hint">
        Chat images, and files in channels and folders you sync, are downloaded up to this size. Everything else
        stays on other members' devices, shown with its name, size and a preview, until you open it or sync that
        file. Synced files are kept on this device and updated when they change.
      </p>
      <h3>Power saving</h3>
      <div class="settings-field">
        <span>Save power</span>
        <Select<PowerSavingChoice> label="Power saving" value={powerSavingChoice()} onChange={setPowerSavingChoice}
          options={[
            { value: "auto", label: "On battery" },
            { value: "on", label: "Always" },
            { value: "off", label: "Never" },
          ]} />
      </div>
      <p class="hint">
        Leaves out effects that redraw the window all the time: the fading edges of scrolling areas, animated typing
        and loading dots, blinking bots and the Nodes globe turning by itself; spinners tick instead of turning.
        Scrolling stays smoother on a laptop and the battery lasts longer. Set for this device only.
      </p>
      <Show when={desktop}>
        <DesktopSettings />
      </Show>
    </div>
  );
}

function DesktopSettings() {
  const [settings, { mutate }] = createResource(() => desktop?.background?.get());
  const change = async (changes: Partial<BackgroundSettings>) => {
    try {
      mutate(await desktop!.background!.set(changes));
    } catch (e) {
      console.warn(desktopError(e).message);
    }
  };
  return (
    <>
      <h3>Desktop</h3>
      <Show when={settings()} fallback={<p class="hint">Restart the app to finish updating it.</p>}>
        {(s) => (
          <>
            <label class="settings-check">
              <input type="checkbox" checked={s().closeToTray} onChange={(e) => void change({ closeToTray: e.currentTarget.checked })} />
              Keep running in the tray when the window is closed
            </label>
            <p class="hint">
              Calls, messages and downloads go on while the window is hidden. Quit from the tray icon's menu. When off,
              closing the window quits MakeWork.
            </p>
            <label class="settings-check">
              <input type="checkbox" checked={s().launchAtStartup} disabled={!s().startupAvailable}
                onChange={(e) => void change({ launchAtStartup: e.currentTarget.checked })} />
              Start MakeWork when the computer starts
            </label>
            <p class="hint">
              <Show when={s().startupAvailable} fallback="Only in the installed app.">
                It starts in the tray when closing to the tray is on, else with its window open.
              </Show>
            </p>
            <Show when={s().gpu}>
              <div class="settings-field">
                <span>Graphics</span>
                <Select<GpuChoice> label="Graphics" value={s().gpu} onChange={(gpu) => void change({ gpu })}
                  options={[
                    { value: "auto", label: "Automatic" },
                    { value: "integrated", label: "Integrated (saves power)" },
                    { value: "discrete", label: "High performance" },
                  ]} />
              </div>
              <p class="hint">
                For computers with two graphics cards. Automatic draws on the integrated one on a laptop, which uses less
                power, and leaves the choice to the system elsewhere. Choose High performance when the window is on a
                monitor plugged into the other card.
                <Show when={s().gpuRestart}> Restart MakeWork to switch.</Show>
              </p>
            </Show>
          </>
        )}
      </Show>
    </>
  );
}
