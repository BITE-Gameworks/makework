// Shows the open overlay page (core/ui.ts overlay): the app's settings or a workspace's. Keeps the last one while it
// fades out.
import { Match, Show, Switch, createMemo } from "solid-js";
import { workspaces } from "../core/workspaces";
import { closeOverlays, overlay, showOverlay, type Overlay } from "../core/ui";
import OverlayPage from "../ui/OverlayPage";
import { createPresence } from "../ui/presence";
import { SettingsContent, settingsSections } from "./Settings";
import { WorkspaceSettingsContent, workspaceSettingsSections } from "./WorkspaceSettings";

export default function Overlays() {
  const presence = createPresence(() => overlay() !== null);
  const shown = createMemo<Overlay | null>((previous) => overlay() ?? previous, null);
  const server = () => {
    const o = shown();
    return o?.kind === "workspace" ? o : null;
  };
  return (
    <Show when={presence.mounted()}>
      <Switch>
        <Match when={shown()?.kind === "app"}>
          <OverlayPage visible={presence.visible()} title="Settings" sections={settingsSections} section={shown()!.section}
            onSection={(section) => showOverlay({ kind: "app", section })} onClose={closeOverlays}>
            <SettingsContent section={shown()!.section} />
          </OverlayPage>
        </Match>
        <Match when={server()}>
          {(o) => (
            <OverlayPage visible={presence.visible()} title={`${workspaces.byId[o().workspaceId]?.info.name ?? "Workspace"} ${o().section === "profile" ? "profile" : "settings"}`}
              sections={o().section === "profile" ? [] : workspaceSettingsSections.filter((s) => s.id !== "profile")} section={o().section}
              onSection={(section) => showOverlay({ kind: "workspace", workspaceId: o().workspaceId, section })} onClose={closeOverlays}>
              <WorkspaceSettingsContent workspaceId={o().workspaceId} section={o().section} />
            </OverlayPage>
          )}
        </Match>
      </Switch>
    </Show>
  );
}
