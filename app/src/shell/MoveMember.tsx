// Server settings > Members, for the owner: move a member who lost their account to their new one
// (core/memberMove.ts). The new account must have joined the workspace first.
import { Show, createSignal } from "solid-js";
import { userMessage } from "../api/client";
import { moveMember } from "../core/memberMove";
import { currentId, member, memberListVisible, myId } from "../core/members";
import { isBanned, workspaceOwner } from "../core/roles";
import { handleOf } from "../core/userServer";
import Collapse from "../ui/Collapse";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import Select from "../ui/Select";

export function canMoveMember(workspaceId: string, userId: number): boolean {
  const me = myId(workspaceId);
  return me !== null && me === workspaceOwner(workspaceId) && userId !== me && currentId(workspaceId, userId) === userId;
}

// Opened from the member's menu.
export default function MoveMember(props: { workspaceId: string; userId: number; name: string; open: boolean; onClose: () => void }) {
  const [target, setTarget] = createSignal<number | null>(null);
  const [asking, setAsking] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const options = () => memberListVisible(props.workspaceId)
    .filter((m) => m.id !== props.userId && m.id !== myId(props.workspaceId) && !isBanned(props.workspaceId, m.id))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((m) => ({ value: m.id, label: `${m.displayName} (${handleOf(m)})` }));
  const newName = () => (target() === null ? "" : `${member(props.workspaceId, target()!).displayName} (${handleOf(member(props.workspaceId, target()!))})`);
  const move = async () => {
    setAsking(false);
    setBusy(true);
    setError("");
    try {
      await moveMember(props.workspaceId, props.userId, target()!, props.name);
      props.onClose();
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="move-member">
      <Collapse open={props.open}>
        <div class="move-member-panel">
          <p class="hint">
            For someone who lost their account: their new account joins with an invite, then everything of theirs here
            moves to it (roles, messages, tasks, reactions, mentions, history). This account is banned. Private messages
            and friends don't move.
          </p>
          <Select label="New account" value={target()} placeholder="Their new account" options={options()} onChange={setTarget} />
          <div class="move-member-actions">
            <button class="mw-button primary mw-box" disabled={target() === null || busy()} onClick={() => setAsking(true)}>
              {busy() ? "Moving..." : "Move"}
            </button>
            <button class="mw-button mw-box" onClick={props.onClose}>Cancel</button>
          </div>
          <ConfirmPrompt open={asking()} confirmLabel="Move" onCancel={() => setAsking(false)} onConfirm={() => void move()}
            question={`Move ${props.name} to ${newName()}? Everything of theirs becomes the new account's, and ${props.name}'s account is banned here.`} />
          <Show when={error()}><p class="warning">{error()}</p></Show>
        </div>
      </Collapse>
    </div>
  );
}
