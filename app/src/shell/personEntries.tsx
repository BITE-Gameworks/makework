import { setSidePanel } from "../core/ui";
import { showNotice } from "../core/notices";
import type { RelationChange } from "../core/userServer";
import { askedBy, askedThem, changeFriend, isBlocked, isFriend } from "../dm/friends";
import type { MenuEntry } from "../ui/contextMenu";
import { ConfirmItem } from "./channelMenu";
import ReportAccount from "./ReportAccount";

// Friend, block and report actions for another account, the same in a workspace's member menu and in private messages.
// They go by account id, so a shared name·tag can't reach the wrong person.
export function personEntries(id: string, name: string, options: { onBlocked?: () => void } = {}): MenuEntry[] {
  const change = (action: RelationChange, failed: string) => void changeFriend(action, id).catch((e) =>
    showNotice(failed, e instanceof Error ? e.message : String(e)));
  const report: MenuEntry = {
    label: "Report", icon: "warning", danger: true,
    action: () => setSidePanel({ title: "Report", render: () => <ReportAccount accountId={id} name={name} /> }),
  };
  if (isBlocked(id)) return [{ label: "Unblock", icon: "visible", action: () => change("unblock", "Not unblocked") }, report];
  const friend: MenuEntry = isFriend(id)
    ? { render: () => <ConfirmItem label="Remove friend" icon="close" confirmLabel="Remove" question={`Remove ${name} from your friends?`}
      onConfirm={() => changeFriend("remove", id)} /> }
    : askedThem(id) ? { label: "Friend request sent", icon: "profile", disabled: true, action: () => {} }
    : askedBy(id) ? { label: "Accept friend request", icon: "check", action: () => change("accept", "Friend request not accepted") }
    : { label: `Add ${name} as friend`, icon: "add", action: () => change("request", "Friend request not sent") };
  const block: MenuEntry = {
    render: () => <ConfirmItem label="Block" icon="hidden" confirmLabel="Block"
      question={`Block ${name}? They can't message you or send you friend requests, and they aren't told.`}
      onConfirm={async () => {
        await changeFriend("block", id);
        options.onBlocked?.();
      }} />,
  };
  return [friend, block, report];
}
