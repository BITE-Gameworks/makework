import { For, Show, createResource } from "solid-js";
import { openFeedback, systemLabel } from "../core/feedback";
import { member } from "../core/members";
import { peerVersions } from "../core/presence";
import { openDownloadPage, updateAvailable } from "../core/updates";
import { hostOf, userServer, userServerVersion } from "../core/userServer";
import { appVersion, compareVersions, newerThanMine } from "../core/version";
import { workspaceList, type WorkspaceData } from "../core/workspaces";
import { nodePeers } from "../p2p/nodes";
import { Icon } from "../theme/icons";
import Skeleton from "../ui/Skeleton";

const namesShown = 5;

// Who runs which version in a workspace, newest first: members who are online and not hidden, and its nodes.
function versionsIn(workspaceId: string): { version: string; names: string[] }[] {
  const byVersion = new Map<string, string[]>();
  const add = (version: string, name: string) => byVersion.set(version, [...(byVersion.get(version) ?? []), name]);
  for (const [user, version] of Object.entries(peerVersions(workspaceId))) add(version, member(workspaceId, Number(user)).displayName);
  for (const node of nodePeers(workspaceId)) if (node.app) add(node.app, `${member(workspaceId, node.user).displayName} (node)`);
  return [...byVersion].map(([version, names]) => ({ version, names })).sort((a, b) => compareVersions(b.version, a.version));
}

function WorkspaceVersions(props: { workspace: WorkspaceData }) {
  const versions = () => versionsIn(props.workspace.id);
  return (
    <Show when={versions().length > 0}>
      <div class="about-workspace">
        <strong>{props.workspace.info.name}</strong>
        <ul class="about-versions">
          <For each={versions()}>
            {(entry) => (
              <li class="mw-fade-in">
                <span>{entry.version}</span>
                <Show when={newerThanMine(entry.version)}><span class="hint"> (newer than yours)</span></Show>
                <span class="hint">
                  {" "}{entry.names.slice(0, namesShown).join(", ")}
                  <Show when={entry.names.length > namesShown}> and {entry.names.length - namesShown} more</Show>
                </span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}

// Settings > About: what this app, the people in its workspaces and its user server run, and where to send feedback.
export default function AboutSettings() {
  const [server] = createResource(userServer, async () => {
    try {
      return { version: await userServerVersion(), reached: true };
    } catch {
      return { version: null, reached: false };
    }
  });
  const anyoneShown = () => workspaceList().some((workspace) => versionsIn(workspace.id).length > 0);
  return (
    <div class="settings-section account-settings">
      <h2>About</h2>
      <div class="account-field">
        <span>MakeWork</span>
        <strong>Version {appVersion}</strong>
        <p class="hint">{systemLabel()}. This is an early version and may have some bugs.</p>
        <Show when={updateAvailable()}>
          <button class="mw-button primary mw-box mw-fade-in" onClick={openDownloadPage}><Icon name="download" /> Get version {updateAvailable()}</button>
        </Show>
      </div>
      <div class="account-field">
        <span>User server</span>
        <Show when={server()} fallback={<Skeleton kind="line" />}>
          {(info) => (
            <span class="mw-fade-in">
              {hostOf()}: {info().reached ? (info().version ? `version ${info().version}` : "doesn't report a version") : "can't be reached right now"}
            </span>
          )}
        </Show>
      </div>
      <div class="account-field">
        <span>Others</span>
        <Show when={anyoneShown()} fallback={<p class="hint">Nobody who shares a version is online right now.</p>}>
          <For each={workspaceList()}>{(workspace) => <WorkspaceVersions workspace={workspace} />}</For>
        </Show>
        <p class="hint">Members who are online and not hidden share their version. Workspaces themselves have no server: their nodes are listed here.</p>
      </div>
      <div class="account-field">
        <span>Feedback</span>
        <button class="mw-button mw-box" onClick={() => openFeedback()}><Icon name="comment" /> Send feedback</button>
        <p class="hint">Found a bug or have an idea? It helps a lot.</p>
      </div>
    </div>
  );
}
