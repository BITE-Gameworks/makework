import { Match, Switch } from "solid-js";
import PluginSettings from "../plugins/PluginSettings";
import ThemeSettings from "../theme/ThemeSettings";
import AudioSettings from "../voice/AudioSettings";
import AccountSettings from "./AccountSettings";
import AboutSettings from "./AboutSettings";
import ApplicationSettings from "./ApplicationSettings";
import ProfileSettings from "./ProfileSettings";
import ServicesSettings from "./ServicesSettings";

export const settingsSections = [
  { id: "account", label: "Account", keywords: "email password sign out github recovery export" },
  { id: "profile", label: "Profile", keywords: "avatar name color status away privacy location typing" },
  { id: "appearance", label: "Appearance", keywords: "theme colors fonts icons sound pack credits" },
  { id: "audio", label: "Audio", keywords: "notifications volume microphone mic sounds push to talk noise" },
  { id: "application", label: "Application", keywords: "downloads tray startup files" },
  { id: "plugins", label: "Plugins", keywords: "install mwp" },
  { id: "server", label: "Connections", keywords: "user server turn" },
  { id: "about", label: "About", keywords: "version feedback bug crash report email" },
] as const;

// The app's settings sections, shown in the overlay page (shell/Overlays.tsx).
export function SettingsContent(props: { section: string }) {
  const section = () => props.section;
  return (
    <Switch>
      <Match when={section() === "account"}>
        <div class="mw-fade-in"><AccountSettings /></div>
      </Match>
      <Match when={section() === "profile"}>
        <div class="mw-fade-in"><ProfileSettings /></div>
      </Match>
      <Match when={section() === "appearance"}>
        <div class="mw-fade-in"><ThemeSettings /></div>
      </Match>
      <Match when={section() === "audio"}>
        <div class="mw-fade-in"><AudioSettings /></div>
      </Match>
      <Match when={section() === "application"}>
        <div class="mw-fade-in"><ApplicationSettings /></div>
      </Match>
      <Match when={section() === "plugins"}>
        <div class="mw-fade-in"><PluginSettings /></div>
      </Match>
      <Match when={section() === "server"}>
        <div class="mw-fade-in"><ServicesSettings /></div>
      </Match>
      <Match when={section() === "about"}>
        <div class="mw-fade-in"><AboutSettings /></div>
      </Match>
    </Switch>
  );
}
