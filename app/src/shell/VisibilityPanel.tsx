// Who sees a channel or category and who may change things in it: rules per role or member (p2p/visibility.ts).
// `ChannelAccess` is the editor, used in the side panel (right-click a channel or category, "Permissions") and
// in Server settings > Channels.
import { For, Show, createSignal } from "solid-js";
import { userMessage } from "../api/client";
import type { Row } from "../api/types";
import { member, memberListVisible } from "../core/members";
import { can, roleList } from "../core/roles";
import { channelLabel, editableBy, seenBy, workspaceApi, workspaces } from "../core/workspaces";
import type { VisibilityTarget } from "../p2p/visibility";
import { Icon } from "../theme/icons";
import Avatar from "../ui/Avatar";
import Select from "../ui/Select";
import "./VisibilityPanel.css";

export default function VisibilityPanel(props: { workspaceId: string; target: VisibilityTarget; id: number }) {
  return (
    <div class="visibility-panel">
      <AccessTitle {...props} />
      <ChannelAccess {...props} />
    </div>
  );
}

export function AccessTitle(props: { workspaceId: string; target: VisibilityTarget; id: number }) {
  const server = () => workspaces.byId[props.workspaceId];
  const channel = () => (props.target === "channel" ? server()?.allChannels.find((c) => c.id === props.id) : undefined);
  const category = () => (props.target === "category" ? server()?.allCategories.find((c) => c.id === props.id) : undefined);
  return (
    <p class="visibility-title">
      <Icon name={props.target === "channel" ? "channel-chat" : "folder"} />
      <strong>{channel() ? channelLabel(props.workspaceId, channel()!) : category()?.name ?? ""}</strong>
    </p>
  );
}

type Setting = "visible" | "edit";
type Choice = "allow" | "deny" | "unset";

const choices: Record<Setting, { value: Choice; label: string; icon: string }[]> = {
  visible: [
    { value: "unset", label: "Not set", icon: "remove" },
    { value: "allow", label: "Sees it", icon: "visible" },
    { value: "deny", label: "Hidden", icon: "hidden" },
  ],
  edit: [
    { value: "unset", label: "Not set", icon: "remove" },
    { value: "allow", label: "Can edit", icon: "rename" },
    { value: "deny", label: "Read-only", icon: "lock" },
  ],
};

const choiceOf = (value: unknown): Choice => (value === true ? "allow" : value === false ? "deny" : "unset");

export function ChannelAccess(props: { workspaceId: string; target: VisibilityTarget; id: number }) {
  const [error, setError] = createSignal("");
  const server = () => workspaces.byId[props.workspaceId];
  const allowed = () => can(props.workspaceId, "manage_channels");
  const channel = () => (props.target === "channel" ? server()?.allChannels.find((c) => c.id === props.id) : undefined);
  const categoryId = () => (props.target === "channel" ? channel()?.categoryId ?? null : props.id);
  const category = () => server()?.allCategories.find((c) => c.id === categoryId());
  const rules = () => (server()?.visibility ?? []).filter((r) => r.target === props.target && r.target_id === props.id);
  const everyone = () => roleList(props.workspaceId).find((r) => r.everyone);
  // @everyone first, then roles from the highest down, then members.
  const sorted = () => {
    const roleOrder = roleList(props.workspaceId).map((r) => r.id);
    const rank = (r: Row) => r.subject === "role"
      ? (r.subject_id === everyone()?.id ? -1 : roleOrder.indexOf(r.subject_id as number))
      : 1000 + Number(r.subject_id) / 2 ** 53;
    return [...rules()].sort((a, b) => rank(a) - rank(b));
  };

  const set = async (setting: Setting, subject: "role" | "member", subjectId: number, choice: Choice) => {
    setError("");
    const value = choice === "allow" ? true : choice === "deny" ? false : null;
    try {
      await workspaceApi(props.workspaceId).plugin("channels").call(setting === "visible" ? "set-visibility" : "set-edit", {
        target: props.target, target_id: props.id, subject, subject_id: subjectId, [setting]: value,
      });
    } catch (e) {
      setError(userMessage(e));
    }
  };
  const remove = async (rule: Row) => {
    for (const setting of ["visible", "edit"] as const)
      if (typeof rule[setting] === "boolean") await set(setting, rule.subject as "role" | "member", Number(rule.subject_id), "unset");
  };

  const addOptions = () => {
    const taken = new Set(rules().map((r) => `${r.subject}:${r.subject_id}`));
    return [
      ...roleList(props.workspaceId).map((r) => ({ value: `role:${r.id}`, label: r.everyone ? "@everyone" : String(r.name), icon: "admin" })),
      ...memberListVisible(props.workspaceId).map((m) => ({ value: `member:${m.id}`, label: m.displayName, icon: "profile" })),
    ].filter((o) => !taken.has(o.value));
  };
  const add = (value: string) => {
    const [subject, id] = value.split(":");
    const isEveryone = subject === "role" && Number(id) === everyone()?.id;
    // Hiding from everyone and then showing to some is the usual way, so @everyone starts hidden, others shown.
    void set("visible", subject as "role" | "member", Number(id), isEveryone ? "deny" : "allow");
  };

  const target = () => ({ channelId: props.target === "channel" ? props.id : undefined, categoryId: categoryId() });
  const seen = () => seenBy(props.workspaceId, target());
  const editing = () => editableBy(props.workspaceId, target());

  return (
    <div class="channel-access">
      <p class="hint">
        {props.target === "channel"
          ? `Rules here come before those of ${category()?.name ?? "its category"}. A setting left unset follows the category.`
          : "Applies to every channel in it that has no rule of its own."}
        {" "}A member's own rule beats their roles, and a role that allows beats one that denies. Without any edit
        rule the workspace permissions ("Edit content", "Send messages") decide. The owner and administrators can do
        everything.
      </p>
      <Show when={!everyone()}>
        <p class="hint warning">This workspace has no @everyone role yet; the owner's app adds it.</p>
      </Show>
      <div class="access-rules">
        <Show when={sorted().length > 0}>
          <span class="access-head">Who</span><span class="access-head">View</span><span class="access-head">Edit</span><span />
        </Show>
        <For each={sorted()} fallback={<p class="hint access-empty">No rules: {props.target === "channel" ? "like its category." : "each role's default applies (Workspace settings > Roles)."}</p>}>
          {(rule) => {
            const isRole = rule.subject === "role";
            const role = () => roleList(props.workspaceId).find((r) => r.id === rule.subject_id);
            const subject = rule.subject as "role" | "member";
            return (
              <>
                <span class="visibility-subject mw-fade-in">
                  <Show when={isRole} fallback={<><Avatar user={member(props.workspaceId, Number(rule.subject_id))} size={20} />{member(props.workspaceId, Number(rule.subject_id)).displayName}</>}>
                    <span class="role-dot" style={{ background: String(role()?.color || "var(--mw-text-disabled)") }} />
                    {role()?.everyone ? "@everyone" : String(role()?.name ?? "Deleted role")}
                  </Show>
                </span>
                <For each={["visible", "edit"] as const}>
                  {(setting) => (
                    <Select label={setting === "visible" ? "View" : "Edit"} value={choiceOf(rule[setting])} disabled={!allowed()}
                      options={choices[setting]} onChange={(v) => void set(setting, subject, Number(rule.subject_id), v)} />
                  )}
                </For>
                <button class="icon-button" title="Remove rule" aria-label="Remove rule" disabled={!allowed()} onClick={() => void remove(rule)}>
                  <Icon name="close" />
                </button>
              </>
            );
          }}
        </For>
      </div>
      <Show when={allowed() && addOptions().length > 0}>
        <Select label="Add a rule" value={null} placeholder="Add a role or member" options={addOptions()} onChange={add} />
      </Show>
      <p class="hint">{seen().seeing} of {seen().total} members see it; {editing().editing} can change things in it.</p>
      <p class="hint">
        Hiding keeps it out of the app for them and refuses their changes there, but every member still receives the
        channel's data.
      </p>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </div>
  );
}
