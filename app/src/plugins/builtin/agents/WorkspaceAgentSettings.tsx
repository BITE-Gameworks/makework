// The agents plugin's part of Workspace settings > Plugins: what its agents share across a workspace.
import { Show, createResource, createSignal } from "solid-js";
import { isScratchpadName, scratchpadCategory, scratchpadChannel } from "../../../agents/scratchpad";
import { userMessage } from "../../../api/client";
import { localServerUrl } from "../../../core/llm";
import { can } from "../../../core/roles";
import { addCategory, addChannel, workspaceApi, workspaces } from "../../../core/workspaces";
import { serverDefaultKey, stepsDefaultKey, workspaceDefault } from "./settings";

export default function WorkspaceAgentSettings(props: { workspaceId: string }) {
  const [error, setError] = createSignal("");
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(userMessage(e));
    }
  };
  const bots = () => workspaceApi(props.workspaceId).plugin("bots");
  const [defaults, { refetch }] = createResource(() => props.workspaceId, async () => ({
    server: await workspaceDefault(bots(), serverDefaultKey),
    steps: await workspaceDefault(bots(), stepsDefaultKey),
  }));
  const save = (key: string, value: string) => void run(async () => {
    await bots().call("set-default", { key, value: value.trim() });
    await refetch();
  });
  const hasScratchpad = () => (workspaces.byId[props.workspaceId]?.categories ?? []).some((c) => isScratchpadName(c.name));
  return (
    <>
      <label class="account-field">
        <span>Default language model server</span>
        <input class="mw-input mw-box" type="text" placeholder={localServerUrl} disabled={!can(props.workspaceId, "manage_bots")}
          value={defaults()?.server ?? ""} onChange={(e) => save(serverDefaultKey, e.currentTarget.value)} />
        <span class="hint">For agents without an address of their own. Members can see it, and localhost means the device running the agent.</span>
      </label>
      <label class="account-field">
        <span>Default steps per agent task <span class="hint">(an agent's own setting wins, 12 when empty)</span></span>
        <input class="mw-input mw-box" type="number" min="1" max="50" placeholder="12" disabled={!can(props.workspaceId, "manage_bots")}
          value={defaults()?.steps ?? ""} onChange={(e) => save(stepsDefaultKey, e.currentTarget.value)} />
      </label>
      <Show when={can(props.workspaceId, "manage_channels") && !hasScratchpad()}>
        <p class="hint">
          Agents with the memory permission keep working notes in a "{scratchpadCategory}" category, dimmed and marked for bots.
          <button class="mw-button mw-box" onClick={() => void run(async () => {
            const categoryId = await addCategory(props.workspaceId, scratchpadCategory);
            await addChannel(props.workspaceId, categoryId, scratchpadChannel, "docs");
          })}>Create it</button>
        </p>
      </Show>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </>
  );
}
