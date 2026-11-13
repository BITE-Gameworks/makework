// Where a serverless workspace is kept on this computer (desktop), from its right-click menu: the app's data or a
// folder of its own, shown with "Show in folder" and moved with "Move to another folder...".
import { Show, createResource, createSignal, onCleanup } from "solid-js";
import { desktop, desktopError } from "../core/desktop";
import { relocateServerless } from "../core/serverless";
import { workspaces } from "../core/workspaces";
import { Icon } from "../theme/icons";
import Collapse from "../ui/Collapse";
import { ProgressBar } from "../ui/UploadList";

export default function WorkspaceStorage(props: { workspaceId: string }) {
  const storage = desktop!.storage!;
  const [location, { refetch }] = createResource(() => storage.location(props.workspaceId));
  const [moving, setMoving] = createSignal<{ stage: string; value: number } | null>(null);
  const [error, setError] = createSignal("");
  const name = () => workspaces.byId[props.workspaceId]?.info.name ?? "";

  onCleanup(storage.onMoveProgress((p) => {
    if (p.workspaceId === props.workspaceId && moving()) setMoving({ stage: p.stage, value: p.total ? p.done / p.total : 0 });
  }));

  const show = () => void desktop!.mirror?.open(props.workspaceId, name()).catch((e) => setError(desktopError(e).message));

  const move = async () => {
    setError("");
    try {
      const folder = await storage.pick(props.workspaceId);
      if (!folder) return;
      setMoving({ stage: "closing", value: 0 });
      await relocateServerless(props.workspaceId, folder);
    } catch (e) {
      setError(desktopError(e).message);
    } finally {
      setMoving(null);
      void refetch();
    }
  };

  const stageText: Record<string, string> = { closing: "Closing the workspace...", copying: "Copying...", cleaning: "Removing the old copy..." };

  return (
    <div class="workspace-storage">
      <h3><Icon name="storage" /> Stored on this computer</h3>
      <p class="where" title={location() ?? undefined}>
        <Show when={location()} fallback={<>In the app's data. Readable copies of synced files are in your MakeWork folder.</>}>
          {(folder) => <code>{folder()}</code>}
        </Show>
      </p>
      <Collapse open={moving() !== null}>
        <div class="workspace-storage-progress">
          <span class="muted">{stageText[moving()?.stage ?? ""] ?? ""}</span>
          <ProgressBar value={moving()?.value ?? 0} label="Moving the workspace" />
        </div>
      </Collapse>
      <div class="workspace-storage-actions">
        <button class="mw-button mw-box" disabled={moving() !== null} onClick={show}>
          <Icon name="folder" /> Show in folder
        </button>
        <button class="mw-button mw-box" disabled={moving() !== null} onClick={() => void move()}>
          <Icon name="folder-upload" /> Move to another folder...
        </button>
      </div>
      <p class="hint">A workspace's folder holds its history, its files and readable copies of them. Choose an empty folder.</p>
      <Collapse open={error() !== ""}>
        <p class="add-workspace-error" role="alert">{error()}</p>
      </Collapse>
    </div>
  );
}
