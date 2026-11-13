import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { channelType } from "../core/channelTypes";
import { activeTabId, closeTabs, messagesHome, moveTab, moveToWindow, openInNewTab, openInNewTabAt, poppable, selectTab, tabLocation, tabs, type Location, type Tab } from "../core/navigation";
import { canPopOutWindows, cancelTabDrag, closeWindow, endTabDrag, isPopout, moveTabDrag, onDragRegion, onTabDraggedAway, onTabDraggedOver, onTabHandedOver, returnToMain, startTabDrag, type DragRegion } from "../core/popout";
import { conversation } from "../dm/messages";
import { findCategory, findChannel, workspaces } from "../core/workspaces";
import { closeOverlays, drawerOpen, narrow, setDrawerOpen } from "../core/ui";
import { Icon } from "../theme/icons";
import { openContextMenu } from "../ui/contextMenu";
import { motionMs } from "../ui/presence";
import { call, isInCall } from "../voice/state";
import { HangUpButton, MicButton } from "../voice/Controls";
import { newBlankTab as newTab } from "./shortcuts";
import { newWindowEntry } from "./windowMenu";
import { moveFocus } from "../ui/rovingFocus";

// A tab dragged with the pointer: HTML drag-and-drop can't leave the window, and a tab must be able to land on the
// desktop (a new window) or on the main window. So the pointer is captured on the strip and its screen position is
// handed to the main process (core/popout.ts), which decides what is under it; a drag that stays in the strip just
// reorders the tabs.
interface Dragged {
  tabId: number;
  place: Location;
  pointerId: number;
  fromIndex: number;
  startX: number;
  startY: number;
  started: boolean;
  // Whether this tab may leave the window; a voice tab, Messages or an empty tab may only be reordered here.
  windowable: boolean;
}
const dragThreshold = 4;
const hintOffset = 14;

// Open channels, browser style. Spans the top of the main view and side panel up to the window controls. In a view
// window it is the same bar with the one tab that window holds.
export default function TabBar() {
  const [closing, setClosing] = createSignal<number[]>([]);
  const [dropAt, setDropAt] = createSignal<number | null>(null);
  const [region, setRegion] = createSignal<DragRegion>("self");
  const [stay, setStay] = createSignal(false);
  const [hint, setHint] = createSignal<{ x: number; y: number } | null>(null);
  let strip: HTMLDivElement | undefined;
  let dragged: Dragged | null = null;
  let suppressClick = false;
  let lastSent = 0;

  // Fades the tabs out, then closes them.
  const close = (ids: number[]) => {
    setClosing((list) => [...list, ...ids]);
    setTimeout(() => {
      closeTabs(ids);
      setClosing((list) => list.filter((id) => !ids.includes(id)));
    }, motionMs());
  };

  // Where a tab dropped at this x would land: before the tab whose middle the pointer hasn't passed yet.
  const indexAt = (x: number): number => {
    if (!strip) return tabs().length;
    const els = [...strip.querySelectorAll<HTMLElement>(".tab")];
    const at = els.findIndex((el) => x < el.getBoundingClientRect().left + el.offsetWidth / 2);
    return at < 0 ? els.length : at;
  };

  const insideStrip = (x: number, y: number): boolean => {
    const rect = strip?.getBoundingClientRect();
    return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };

  const hintText = (where: DragRegion): string => {
    if (stay()) return "This tab stays in the main window";
    if (where === "desktop") return canPopOutWindows() ? "Release for a new window" : "Release to cancel";
    if (where === "main") return "Release to move into the main window";
    if (where === "popout") return "Another channel's window can't take this tab";
    return "Drop between tabs to reorder";
  };

  const endDrag = async (e: PointerEvent) => {
    const active = dragged;
    dragged = null;
    setHint(null);
    dropPointer(e.pointerId);
    if (!active?.started) return;
    // The release right after a drag is not a click on the tab: drop the click it may still send, and clear the
    // flag on the next turn (a captured pointer makes the click land on the strip, so nothing else would clear it).
    suppressClick = true;
    setTimeout(() => (suppressClick = false));
    const at = dropAt();
    setDropAt(null);
    setStay(false);
    const result = active.windowable ? await endTabDrag(active.place, e.screenX, e.screenY) : "none";
    setRegion("self");
    if (result === "created") close([active.tabId]);
    else if (result === "returned") closeWindow();
    else if (at !== null) moveTab(active.tabId, at > active.fromIndex ? at - 1 : at);
  };

  const cancelDrag = () => {
    const active = dragged;
    dragged = null;
    setDropAt(null);
    setHint(null);
    setStay(false);
    setRegion("self");
    if (active?.started) cancelTabDrag();
  };

  const dropPointer = (pointerId: number) => {
    if (strip?.hasPointerCapture(pointerId)) strip.releasePointerCapture(pointerId);
  };

  // The strip is one tab stop (the shown tab): the arrow keys reach the other tabs, Enter or Space shows the one
  // that has the focus. Keys on a tab's close button are the button's.
  const tabKey = (e: KeyboardEvent & { currentTarget: HTMLElement }, tab: Tab) => {
    if (moveFocus(e, '[role="tablist"]', '[role="tab"]') || e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    closeOverlays();
    selectTab(tab.id);
  };

  const onPointerDown = (e: PointerEvent, tab: Tab, index: number) => {
    const place = tabLocation(tab);
    if (e.button !== 0 || !place) return;
    // The close button is a button in the tab: pressing it must not start a drag (its click still has to land on it).
    if ((e.target as HTMLElement).closest(".tab-close")) return;
    const channel = findChannel(place.workspaceId, place.channelId);
    // The pointer is captured once the drag starts, not here: capturing on the press retargets the click, so a
    // plain click on a tab (or on its close button) would land on the strip instead.
    dragged = {
      tabId: tab.id, place, pointerId: e.pointerId, fromIndex: index, startX: e.screenX, startY: e.screenY,
      started: false, windowable: poppable(place, channel && channelType(channel.type)),
    };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== dragged?.pointerId) return;
    if (!dragged.started) {
      if (Math.abs(e.screenX - dragged.startX) < dragThreshold && Math.abs(e.screenY - dragged.startY) < dragThreshold) return;
      dragged.started = true;
      strip?.setPointerCapture(e.pointerId);
      setRegion("self");
      // Only tabs that may leave the window ask the main process to follow the pointer; the rest still reorder here.
      if (dragged.windowable) startTabDrag(dragged.place);
    }
    // The pointer can leave the window while the button is held: keep the hint inside it, where it is visible.
    setHint({
      x: Math.max(4, Math.min(window.innerWidth - 8, e.clientX + hintOffset)),
      y: Math.max(4, Math.min(window.innerHeight - 8, e.clientY + hintOffset)),
    });
    const inside = insideStrip(e.clientX, e.clientY);
    if (!dragged.windowable) setStay(!inside);
    setDropAt(region() === "self" && (dragged.windowable || inside) ? indexAt(e.clientX) : null);
    const now = Date.now();
    if (dragged.windowable && now - lastSent >= 50) {
      lastSent = now;
      // Screen coordinates: the main process decides which window the tab is over.
      moveTabDrag(e.screenX, e.screenY);
    }
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragged) cancelDrag();
    };
    document.addEventListener("keydown", onKey);
    const stops = isPopout()
      ? [onDragRegion((where) => setRegion(where))]
      : [
        onDragRegion((where) => setRegion(where)),
        // A tab dragged here from another window: show where it would land, then take it where it was dropped.
        onTabDraggedOver((x) => setDropAt(indexAt(x))),
        onTabDraggedAway(() => setDropAt(null)),
        onTabHandedOver(({ location, activate }) => {
          const at = dropAt();
          setDropAt(null);
          openInNewTabAt(location, at, activate);
        }),
      ];
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      stops.forEach((stop) => stop());
    });
  });

  const menu = (e: MouseEvent, tab: Tab, index: number) => {
    const location = tabLocation(tab);
    const channel = () => location && findChannel(location.workspaceId, location.channelId);
    const others = tabs().filter((t) => t.id !== tab.id).map((t) => t.id);
    const right = tabs().slice(index + 1).map((t) => t.id);
    if (isPopout()) {
      openContextMenu(e, [
        { label: "Move to main window", icon: "window-new", action: () => void returnToMain(location!) },
        "separator",
        { label: "Close", icon: "close", action: () => close([tab.id]) },
      ]);
      return;
    }
    const type = channel() && channelType(channel()!.type);
    const windowable = poppable(location, type);
    openContextMenu(e, [
      { label: "New tab", icon: "tab-new", action: newTab },
      { label: "Duplicate", icon: "copy", disabled: !location, action: () => { selectTab(tab.id); openInNewTab(location!); } },
      "separator",
      ...(type?.ownWindow !== false ? [newWindowEntry("Move to new window", () =>
        moveToWindow(location!.workspaceId, location!.channelId!, type), windowable)] : []),
      "separator",
      { label: "Close", icon: "close", action: () => close([tab.id]) },
      { label: "Close other tabs", disabled: others.length === 0, action: () => close(others) },
      { label: "Close tabs to the right", disabled: right.length === 0, action: () => close(right) },
    ]);
  };

  return (
    <div class="tab-bar" data-drag-region>
      <Show when={narrow()}>
        <button class="tab-menu" classList={{ on: drawerOpen() }} title="Workspaces and channels" aria-label="Workspaces and channels"
          aria-expanded={drawerOpen()} onClick={() => setDrawerOpen(!drawerOpen())}>
          <Icon name="menu" />
        </button>
      </Show>
      <div class="tabs" role="tablist" aria-label="Open channels" ref={strip}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => void endDrag(e)}
        onPointerCancel={(e) => (e.pointerId === dragged?.pointerId ? cancelDrag() : undefined)}>
        <For each={tabs()}>
          {(tab, index) => {
            const location = () => tabLocation(tab);
            const server = () => workspaces.byId[location()?.workspaceId ?? ""];
            const channel = () => location() && findChannel(location()!.workspaceId, location()!.channelId);
            const dm = () => (location()?.workspaceId === messagesHome ? conversation(location()!.peer) ?? "home" : null);
            const label = () => {
              const d = dm();
              if (d) return d === "home" ? "Messages" : d.displayName;
              return channel()?.name ?? server()?.info.name ?? "New tab";
            };
            const title = () => {
              const c = channel();
              if (!c) return label();
              return `${server()?.info.name} / ${findCategory(location()!.workspaceId, c.categoryId)?.name ?? ""} / ${c.name}`;
            };
            const active = () => tab.id === activeTabId();
            return (
              <div class="tab mw-fade-in" role="tab" aria-selected={active()} title={title()}
                tabIndex={active() ? 0 : -1} onKeyDown={(e) => tabKey(e, tab)}
                classList={{
                  active: active(), closing: closing().includes(tab.id), dragging: dragged?.tabId === tab.id && dragged.started,
                  "drop-before": dropAt() === index(), "drop-after": dropAt() === tabs().length && index() === tabs().length - 1,
                  "in-call": !!channel() && isInCall(location()!.workspaceId, channel()!.id),
                }}
                onClick={() => {
                  if (suppressClick) { suppressClick = false; return; }
                  closeOverlays();
                  selectTab(tab.id);
                }}
                onPointerDown={(e) => onPointerDown(e, tab, index())}
                onAuxClick={(e) => e.button === 1 && (e.preventDefault(), close([tab.id]))}
                onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                onContextMenu={(e) => menu(e, tab, index())}>
                <Show when={channel()}>{(c) => <Icon name={channelType(c().type).icon} />}</Show>
                <Show when={dm()}><Icon name="messages" /></Show>
                <Show when={!channel() && server()}>
                  <span class="tab-workspace">{server()!.info.short || server()!.info.name.slice(0, 2)}</span>
                </Show>
                <span class="tab-label">{label()}</span>
                <button class="tab-close" title="Close tab (middle click)" aria-label={`Close ${label()}`}
                  onClick={(e) => { e.stopPropagation(); close([tab.id]); }}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={!isPopout()}>
        <button class="tab-add" title="New tab" aria-label="New tab" onClick={() => { closeOverlays(); newTab(); }}><Icon name="add" /></button>
      </Show>
      <div class="tab-bar-fill" data-drag-region />
      {/* Narrow: the call panel is in the drawer, so mute and leave stay at hand here. */}
      <Show when={narrow() && call()}>
        <div class="tab-call mw-fade-in">
          <MicButton />
          <HangUpButton />
        </div>
      </Show>
      <Show when={hint()}>
        {(at) => (
          <div class="tab-drag-hint mw-box" classList={{ new: region() === "desktop" }}
            style={{ transform: `translate3d(${at().x}px, ${at().y}px, 0)` }}>
            {hintText(region())}
          </div>
        )}
      </Show>
    </div>
  );
}
