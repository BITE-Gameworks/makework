import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { account } from "../core/account";
import { current, openWorkspace } from "../core/navigation";
import { workspaceImage, workspaceList, workspaces, type WorkspaceData } from "../core/workspaces";
import { closeOverlays, showOverlay, workspacePage } from "../core/ui";
import { groupMentionsOn, setGroupMentionsOn } from "../core/notifier";
import { desktop } from "../core/desktop";
import { isServerless, leaveQuestion, leaveServerless, onlinePeers } from "../core/serverless";
import { hasUnread, serverMentions } from "../core/sidebar";
import {
  addToGroup, barEntries, createGroup, dissolveGroup, groupIdOfToken, groupOfWorkspace, groupToken, isGroupOpen, isGroupToken, moveTopLevel,
  openGroup, removeFromGroup, renameGroup, reorderGroupMembers, toggleGroupOpen, workspaceGroups,
  type BarEntry, type WorkspaceGroup,
} from "../core/workspaceGroups";
import { savedWorkspaceOrder } from "../core/workspaceOrder";
import { Icon, isIconName, type IconName } from "../theme/icons";
import { openContextMenu, type MenuEntry } from "../ui/contextMenu";
import { motionMs } from "../ui/presence";
import Popover from "../ui/Popover";
import Collapse from "../ui/Collapse";
import { MessagesButton } from "../dm/MessagesHome";
import AddWorkspace from "./AddWorkspace";
import { ConfirmItem, RenameItem } from "./channelMenu";
import { draggedItem, finishWorkspaceDrop, setDraggedItem, setWorkspaceDrop, workspaceDrop } from "./workspaceDrag";
import WorkspaceStorage from "./WorkspaceStorage";

export default function WorkspaceBar() {
  let bar!: HTMLElement;
  const [indicator, setIndicator] = createSignal<{ top: number; visible: boolean }>({ top: 0, visible: false });

  // What the bar shows: workspaces and group tiles in the saved order, with a group's connected members inside it.
  // Kept in a store so reconcile keeps each button's identity (and its open storage popover) across reorders.
  const entriesNow = () => barEntries(savedWorkspaceOrder(), workspaceGroups(), workspaceList().map((workspace) => workspace.id));
  const [entries, setEntries] = createStore<BarEntry[]>(entriesNow());
  createEffect(() => setEntries(reconcile(entriesNow(), { key: "id" })));

  // Where an element sits in the bar's scrollable content, also inside an open group.
  const topInBar = (element: HTMLElement) => {
    let top = 0;
    for (let node: HTMLElement | null = element; node && node !== bar; node = node.offsetParent as HTMLElement | null) {
      top += node.offsetTop;
    }
    return top;
  };

  // A bar that slides to the active workspace (or to a collapsed group that holds it).
  const place = () => {
    // A member inside a closing group is inert and folded away; the group tile is active by then.
    const active = [...bar.querySelectorAll<HTMLElement>(".workspace-button.active")]
      .find((button) => !button.closest(".mw-collapse:not(.open)"));
    setIndicator(active ? { top: topInBar(active) + active.offsetHeight / 2, visible: true } : { ...indicator(), visible: false });
  };
  onMount(() => {
    const observer = new MutationObserver(place);
    observer.observe(bar, { subtree: true, attributes: true, attributeFilter: ["aria-current"], childList: true });
    place();
    onCleanup(() => observer.disconnect());
  });

  // Opening a workspace that lives in a group shows it inside the group.
  createEffect(on(() => current()?.workspaceId, (id) => {
    if (!id) return;
    const group = groupOfWorkspace(id);
    if (group) openGroup(group.id);
  }));

  // Top-level tiles are spaced by the bar's gap (a group's own wrapper has none around its tile), members by their list's.
  const halfGap = (tile: HTMLElement) =>
    (Number.parseFloat(getComputedStyle(tile.dataset.topLevel !== undefined ? bar : tile.parentElement!).rowGap) || 0) / 2;

  // Where a drag over the bar's gaps and padding would land: before the first top-level tile whose middle is below
  // the pointer, or at the end. Without it the last tile hovered decided, and a gap next to a group gave a wrong slot.
  const dropAt = (y: number, dragged: NonNullable<ReturnType<typeof draggedItem>>) => {
    const own = dragged.kind === "group" ? groupToken(dragged.id) : dragged.id;
    for (const tile of bar.querySelectorAll<HTMLElement>(".workspace-button[data-top-level]")) {
      const id = tile.dataset.orderId!;
      const rect = tile.getBoundingClientRect();
      if (id === own || y >= rect.top + rect.height / 2) continue;
      const groupId = isGroupToken(id) ? groupIdOfToken(id) : null;
      return dragged.kind === "workspace" && groupId !== null
        ? { kind: "group-edge" as const, groupId, edge: "above" as const }
        : { kind: "top" as const, id, edge: "above" as const };
    }
    return { kind: "end" as const };
  };

  // Where the drop line goes: the top or bottom edge of the entry it would go before or after.
  const dropTop = () => {
    const drop = workspaceDrop();
    if (!drop) return 0;
    if (drop.kind === "end") {
      const last = [...bar.querySelectorAll<HTMLElement>(".workspace-button[data-top-level]")].pop();
      return last ? topInBar(last) + last.offsetHeight + halfGap(last) : 0;
    }
    if (drop.kind === "into") return 0;
    const id = drop.kind === "member"
      ? drop.workspaceId
      : drop.kind === "group-edge" ? groupToken(drop.groupId) : drop.id;
    const target = bar.querySelector<HTMLElement>(`.workspace-button[data-order-id="${CSS.escape(id)}"]`);
    const below = drop.edge === "below";
    // Halfway into the gap, so "below this tile" and "above the next one" draw the line in the same place.
    return target ? topInBar(target) + (below ? target.offsetHeight + halfGap(target) : -halfGap(target)) : 0;
  };

  // FLIP for a moved workspace or group: measure where the buttons were, change the order, then slide them.
  const animateOrder = (change: () => void) => {
    const duration = motionMs();
    if (duration === 0) {
      change();
      return;
    }
    const before = new Map([...bar.querySelectorAll<HTMLElement>(".workspace-button[data-order-id]")]
      .map((button) => [button.dataset.orderId!, topInBar(button)]));
    change();
    requestAnimationFrame(() => {
      for (const button of bar.querySelectorAll<HTMLElement>(".workspace-button[data-order-id]")) {
        const from = before.get(button.dataset.orderId!);
        const to = topInBar(button);
        if (from === undefined || from === to) continue;
        button.animate([{ transform: `translateY(${from - to}px)` }, { transform: "none" }],
          { duration, easing: "cubic-bezier(0.2, 0, 0, 1)" });
      }
    });
  };

  return (
    <nav class="workspace-bar mw-scroll-fade" classList={{ reordering: !!draggedItem() }} aria-label="Workspaces" data-drag-region ref={bar}
      onDragOver={(e) => {
        const dragged = draggedItem();
        if (!dragged) return;
        e.preventDefault();
        if (!(e.target as HTMLElement).closest(".workspace-button, .spacer")) setWorkspaceDrop(dropAt(e.clientY, dragged));
      }}
      onDrop={(e) => draggedItem() && animateOrder(() => finishWorkspaceDrop(e, entries))}>
      <span class="workspace-indicator" classList={{ visible: indicator().visible }}
        style={{ transform: `translateY(${indicator().top}px) translateY(-50%)` }} aria-hidden="true" />
      <Show when={workspaceDrop() && workspaceDrop()!.kind !== "into"}>
        <span class="workspace-drop-line mw-fade-in" style={{ transform: `translateY(${dropTop()}px)` }} aria-hidden="true" />
      </Show>
      <Show when={!account()?.offline}><MessagesButton /></Show>
      {/* A button only while its workspace's data is there: the entries follow the order through an effect, so a
          left workspace's data goes before its entry, and a button reading it threw (core/workspaces.ts). */}
      <For each={entries}>{(entry) =>
        entry.kind === "workspace"
          ? <Show when={workspaces.byId[entry.id]}>{(workspace) => (
            <WorkspaceButton workspace={workspace()} entries={() => entries} animateOrder={animateOrder} topLevel />
          )}</Show>
          : <WorkspaceGroupView entry={entry} entries={() => entries} animateOrder={animateOrder} />
      }</For>
      <AddWorkspace />
      <div class="spacer" data-drag-region
        onDragOver={(e) => {
          if (!draggedItem()) return;
          e.preventDefault();
          setWorkspaceDrop({ kind: "end" });
        }}
        onDrop={(e) => animateOrder(() => finishWorkspaceDrop(e, entries))} />
    </nav>
  );
}

function WorkspaceFace(props: { workspace: WorkspaceData; size?: number }) {
  const info = () => props.workspace.info;
  const icon = () => (isIconName(info().icon) ? info().icon as IconName : undefined);
  return (
    <Switch fallback={info().short || info().name.slice(0, 2)}>
      <Match when={info().pending}><span class="mw-spinner" aria-label="Joining" /></Match>
      <Match when={workspaceImage(info())}>{(src) => <img class="workspace-image" src={src()} alt="" draggable={false} />}</Match>
      <Match when={icon()}>{(name) => <Icon name={name()} size={props.size ?? 22} />}</Match>
    </Switch>
  );
}

function WorkspaceGroupView(props: { entry: Extract<BarEntry, { kind: "group" }>; entries: () => BarEntry[]; animateOrder: (change: () => void) => void }) {
  const group = () => props.entry.group;
  const token = () => groupToken(group().id);
  const open = () => isGroupOpen(group().id);
  const members = () => props.entry.workspaceIds.map((id) => workspaces.byId[id]).filter((workspace) => !!workspace);
  const active = () => !open() && props.entry.workspaceIds.includes(current()?.workspaceId ?? "");
  const unread = () => !open() && props.entry.workspaceIds.some((id) => hasUnread(id));
  const mentions = () => (open() ? 0 : props.entry.workspaceIds.reduce((count, id) => count + serverMentions(id), 0));
  const dropInto = () => {
    const drop = workspaceDrop();
    return drop?.kind === "into" && drop.groupId === group().id;
  };
  const countLabel = () => `${props.entry.workspaceIds.length} ${props.entry.workspaceIds.length === 1 ? "workspace" : "workspaces"}`;
  const tokens = () => props.entries().map((entry) => entry.id);
  const index = () => tokens().indexOf(token());
  let draggedAway = false;

  const moveStep = (step: -1 | 1) => {
    const list = tokens();
    const at = index();
    if (at < 0 || (step < 0 && at === 0) || (step > 0 && at === list.length - 1)) return;
    const before = step < 0 ? list[at - 1] : list[at + 2] ?? null;
    props.animateOrder(() => moveTopLevel(token(), before, props.entries()));
  };

  return (
    <div class="workspace-group">
      <button
        class="workspace-button group mw-box"
        classList={{
          active: active(), unread: unread(), dragging: draggedItem()?.kind === "group" && draggedItem()!.id === group().id,
          "drop-into": dropInto(),
        }}
        data-order-id={token()}
        data-top-level="true"
        draggable={true}
        title={`${group().name} (${countLabel()})`}
        aria-label={`${group().name}, ${countLabel()}`}
        aria-expanded={open()}
        onClick={() => {
          if (draggedAway) return;
          toggleGroupOpen(group().id);
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          moveStep(e.key === "ArrowUp" ? -1 : 1);
        }}
        onDragStart={(e) => {
          draggedAway = true;
          setDraggedItem({ kind: "group", id: group().id });
          e.dataTransfer!.effectAllowed = "move";
          e.dataTransfer!.setData("application/x-makework-workspace-group", group().id);
        }}
        onDragEnd={() => {
          setDraggedItem(null);
          setWorkspaceDrop(null);
          setTimeout(() => (draggedAway = false), 0);
        }}
        onDragOver={(e) => {
          const dragged = draggedItem();
          if (!dragged || (dragged.kind === "group" && dragged.id === group().id)) return;
          e.preventDefault();
          const bounds = e.currentTarget.getBoundingClientRect();
          if (dragged.kind === "group") {
            const above = e.clientY < bounds.top + bounds.height / 2;
            setWorkspaceDrop({ kind: "top", id: token(), edge: above ? "above" : "below" });
            return;
          }
          const y = e.clientY - bounds.top;
          if (y < bounds.height * 0.25) setWorkspaceDrop({ kind: "group-edge", groupId: group().id, edge: "above" });
          else if (y > bounds.height * 0.75) setWorkspaceDrop({ kind: "group-edge", groupId: group().id, edge: "below" });
          else setWorkspaceDrop({ kind: "into", groupId: group().id });
        }}
        onDrop={(e) => props.animateOrder(() => finishWorkspaceDrop(e, props.entries()))}
        onContextMenu={(e) => openContextMenu(e, groupMenu(group(), {
          open: open(),
          canUp: index() > 0,
          canDown: index() >= 0 && index() < tokens().length - 1,
          up: () => moveStep(-1),
          down: () => moveStep(1),
        }, props.animateOrder))}
      >
        <Show when={members().length > 0} fallback={<Icon name="folder" size={20} />}>
          <span class="workspace-group-mosaic" classList={{ single: members().length === 1 }} aria-hidden="true">
            <For each={members().slice(0, 4)}>{(workspace) => (
              <span class="workspace-group-face" style={{ background: workspace.info.color || undefined }}>
                <WorkspaceFace workspace={workspace} size={13} />
              </span>
            )}</For>
          </span>
        </Show>
        <Show when={props.entry.workspaceIds.length > 4}>
          <span class="workspace-group-count" aria-hidden="true">+{props.entry.workspaceIds.length - 4}</span>
        </Show>
        <Show when={mentions()}>
          {(count) => <span class="mention-badge workspace-mentions mw-fade-in" aria-label={`${count()} unread mentions`}>{count()}</span>}
        </Show>
      </button>
      <Collapse open={open()}>
        <div class="workspace-group-members">
          <For each={props.entry.workspaceIds}>{(id) => (
            <Show when={workspaces.byId[id]}>{(workspace) => (
              <WorkspaceButton workspace={workspace()} groupId={group().id} entries={props.entries}
                animateOrder={props.animateOrder} />
            )}</Show>
          )}</For>
        </div>
      </Collapse>
    </div>
  );
}

function WorkspaceButton(props: {
  workspace: WorkspaceData; entries: () => BarEntry[]; animateOrder: (change: () => void) => void;
  groupId?: string; topLevel?: boolean;
}) {
  const active = () => current()?.workspaceId === props.workspace.id;
  const info = () => props.workspace.info;
  const [storageOpen, setStorageOpen] = createSignal(false);
  // A drag ends before its click: don't open the workspace that was just put in a new place.
  let draggedAway = false;

  const memberIds = () => {
    if (!props.groupId) return [];
    const group = workspaceGroups().find((item) => item.id === props.groupId);
    return group ? group.workspaceIds.filter((id) => !!workspaces.byId[id]) : [];
  };
  // Group tiles count as places too, so a workspace moves past one in a single step.
  const topLevelIds = () => props.entries().map((entry) => entry.id);
  const ids = () => (props.groupId ? memberIds() : topLevelIds());
  const index = () => ids().indexOf(props.workspace.id);
  // Arrow keys and the menu move this workspace in its group, or among the top-level workspaces.
  const moveStep = (step: -1 | 1) => {
    const list = ids();
    const at = list.indexOf(props.workspace.id);
    if (at < 0 || (step < 0 && at === 0) || (step > 0 && at === list.length - 1)) return;
    const before = step < 0 ? list[at - 1] : list[at + 2] ?? null;
    if (props.groupId) props.animateOrder(() => reorderGroupMembers(props.groupId!, props.workspace.id, before));
    else props.animateOrder(() => moveTopLevel(props.workspace.id, before, props.entries()));
  };

  return (
    <button
      class="workspace-button mw-box"
      classList={{
        active: active(), unread: !active() && hasUnread(props.workspace.id), nested: !!props.groupId,
        dragging: draggedItem()?.kind === "workspace" && draggedItem()!.id === props.workspace.id,
      }}
      data-workspace-id={props.workspace.id}
      data-order-id={props.workspace.id}
      data-top-level={props.topLevel ? "true" : undefined}
      draggable={true}
      style={{ background: info().color || undefined }}
      title={isServerless(props.workspace.id) ? `${info().name} (${onlinePeers(props.workspace.id)} online)` : info().name}
      aria-label={info().name}
      aria-current={active() ? "page" : undefined}
      onClick={(e) => {
        if (draggedAway || inPopover(e)) return;
        closeOverlays();
        openWorkspace(props.workspace.id);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        moveStep(e.key === "ArrowUp" ? -1 : 1);
      }}
      onDragStart={(e) => {
        draggedAway = true;
        setDraggedItem({ kind: "workspace", id: props.workspace.id });
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("application/x-makework-workspace", props.workspace.id);
      }}
      onDragEnd={() => {
        setDraggedItem(null);
        setWorkspaceDrop(null);
        setTimeout(() => (draggedAway = false), 0);
      }}
      onDragOver={(e) => {
        const dragged = draggedItem();
        if (!dragged || (dragged.kind === "workspace" && dragged.id === props.workspace.id)) return;
        if (props.groupId) {
          // Only a workspace goes among a group's members; a group stays at the top level.
          if (dragged.kind === "group") return;
          e.preventDefault();
          const bounds = e.currentTarget.getBoundingClientRect();
          const above = e.clientY < bounds.top + bounds.height / 2;
          setWorkspaceDrop({
            kind: "member", groupId: props.groupId, workspaceId: props.workspace.id, edge: above ? "above" : "below",
          });
          return;
        }
        e.preventDefault();
        const bounds = e.currentTarget.getBoundingClientRect();
        const above = e.clientY < bounds.top + bounds.height / 2;
        setWorkspaceDrop({ kind: "top", id: props.workspace.id, edge: above ? "above" : "below" });
      }}
      onDrop={(e) => props.animateOrder(() => finishWorkspaceDrop(e, props.entries()))}
      onContextMenu={(e) => !inPopover(e) && isServerless(props.workspace.id) && openContextMenu(e, workspaceMenu(
        props.workspace, () => setStorageOpen(true), {
          canUp: index() > 0,
          canDown: index() >= 0 && index() < ids().length - 1,
          up: () => moveStep(-1),
          down: () => moveStep(1),
        }, {
          group: workspaceGroups().find((group) => group.id === props.groupId),
          groups: workspaceGroups(),
        }, props.animateOrder,
      ))}
    >
      <WorkspaceFace workspace={props.workspace} />
      <Show when={serverMentions(props.workspace.id)}>
        {(count) => <span class="mention-badge workspace-mentions mw-fade-in" aria-label={`${count()} unread mentions`}>{count()}</span>}
      </Show>
      <Show when={desktop?.storage}>
        <Popover open={storageOpen()} onClose={() => setStorageOpen(false)} label={`Where ${info().name} is stored`} placement="below">
          <WorkspaceStorage workspaceId={props.workspace.id} />
        </Popover>
      </Show>
    </button>
  );
}

// Events from the storage popover reach the button through Solid's portal; they aren't clicks on the button.
const inPopover = (e: MouseEvent) => !(e.currentTarget as Node).contains(e.target as Node);

// Which group mentions notify in this workspace; mentions of you always do.
function notificationMenu(workspaceId: string): MenuEntry {
  const on = groupMentionsOn(workspaceId);
  return {
    label: "Notifications", icon: "notification",
    items: [
      { label: "@everyone and @here", icon: on.everyone ? "check" : undefined, action: () => setGroupMentionsOn(workspaceId, { everyone: !on.everyone }) },
      { label: "@role mentions", icon: on.roles ? "check" : undefined, action: () => setGroupMentionsOn(workspaceId, { roles: !on.roles }) },
      { label: "Mentions of you always notify", icon: "check", disabled: true, action: () => {} },
    ],
  };
}

function groupMenu(group: WorkspaceGroup, moves: {
  open: boolean; canUp: boolean; canDown: boolean; up: () => void; down: () => void;
}, animate: (change: () => void) => void): MenuEntry[] {
  return [
    {
      render: () => (
        <RenameItem label="Rename group" value={group.name} clean={(name) => name.trim().slice(0, 64)}
          onSave={async (name) => renameGroup(group.id, name)} />
      ),
    },
    {
      label: moves.open ? "Collapse" : "Expand", icon: moves.open ? "collapsed" : "expanded",
      action: () => toggleGroupOpen(group.id),
    },
    { label: "Move up", icon: "menu-up", disabled: !moves.canUp, action: moves.up },
    { label: "Move down", icon: "expanded", disabled: !moves.canDown, action: moves.down },
    "separator" as const,
    {
      render: () => (
        <ConfirmItem label="Ungroup" icon="design-ungroup" confirmLabel="Ungroup"
          question={`Ungroup ${group.name}? Its workspaces stay in the workspace bar.`}
          onConfirm={async () => animate(() => dissolveGroup(group.id))} />
      ),
    },
  ];
}

function workspaceMenu(workspace: WorkspaceData, openStorage: () => void, moves: {
  canUp: boolean; canDown: boolean; up: () => void; down: () => void;
}, grouping: { group: WorkspaceGroup | undefined; groups: WorkspaceGroup[] },
  animate: (change: () => void) => void): MenuEntry[] {
  const offline = account()?.offline === true;
  const owner = grouping.group;
  const others = grouping.groups.filter((group) => group.id !== owner?.id);
  const groupingEntries: MenuEntry[] = [
    { label: "New group", icon: "folder-add", action: () => animate(() => createGroup([workspace.id])) },
    ...(owner
      ? [{ label: "Remove from group", icon: "design-ungroup", action: () => animate(() => removeFromGroup(owner.id, workspace.id)) }]
      : []),
  ];
  if (others.length > 0) {
    groupingEntries.push({
      label: "Add to group", icon: "folder",
      items: others.map((group) => ({
        label: group.name, icon: "folder", action: () => animate(() => addToGroup(group.id, [workspace.id])),
      })),
    });
  }
  return [
    { label: "Move up", icon: "menu-up", disabled: !moves.canUp, action: moves.up },
    { label: "Move down", icon: "expanded", disabled: !moves.canDown, action: moves.down },
    "separator" as const,
    ...groupingEntries,
    "separator" as const,
    ...(offline ? [] : [{ label: "Invites...", icon: "copy", action: () => showOverlay(workspacePage(workspace.id, "invite")) }]),
    ...(desktop?.storage ? [{ label: "Storage...", icon: "storage", action: openStorage }] : []),
    notificationMenu(workspace.id),
    "separator" as const,
    {
      render: () => (
        <ConfirmItem label="Leave workspace" icon="sign-out" confirmLabel="Leave"
          question={leaveQuestion(workspace.info.name, true)}
          onConfirm={() => leaveServerless(workspace.id, true)} />
      ),
    },
    {
      render: () => (
        <ConfirmItem label="Leave and delete data" confirmLabel="Leave and delete"
          question={leaveQuestion(workspace.info.name, false)}
          onConfirm={() => leaveServerless(workspace.id, false)} />
      ),
    },
  ];
}
