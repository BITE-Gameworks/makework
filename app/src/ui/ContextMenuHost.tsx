import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Icon } from "../theme/icons";
import Collapse from "./Collapse";
import { closeContextMenu, contextMenu, type MenuEntry, type MenuItem, type MenuSubmenu, type OpenMenu } from "./contextMenu";
import { createPresence, motionMs } from "./presence";
import "./Popover.css";

export default function ContextMenu() {
  const presence = createPresence(() => contextMenu() !== null);
  // Keeps the last menu while it fades out.
  const [shown, setShown] = createSignal<OpenMenu | null>(null);
  createEffect(() => {
    const menu = contextMenu();
    if (menu) setShown(menu);
  });

  return (
    <Show when={presence.mounted() && shown()} keyed>
      {(menu) => <Menu menu={menu} visible={presence.visible()} />}
    </Show>
  );
}

function Menu(props: { menu: OpenMenu; visible: boolean }) {
  let panel!: HTMLDivElement;
  const [place, setPlace] = createSignal({ x: props.menu.x, y: props.menu.y });

  const items = () => [...panel.querySelectorAll<HTMLButtonElement>(".mw-menu-item:not(:disabled)")].filter((b) => !b.closest("[inert]"));
  const run = (item: MenuItem) => {
    closeContextMenu();
    item.action();
  };

  createEffect(() => {
    if (!contextMenu()) return;
    // Kept inside the window: flips left or up near the edges.
    const r = panel.getBoundingClientRect();
    setPlace({
      x: props.menu.x + r.width > innerWidth - 4 ? Math.max(4, props.menu.x - r.width) : props.menu.x,
      y: props.menu.y + r.height > innerHeight - 4 ? Math.max(4, props.menu.y - r.height) : props.menu.y,
    });
    items()[0]?.focus({ preventScroll: true });

    const onPointer = (e: PointerEvent) => !panel.contains(e.target as Node) && closeContextMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
      // Arrows move between items, except inside a field in the menu (a rename box).
      else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !(e.target as HTMLElement).closest?.("input, textarea")) {
        const list = items();
        const at = list.indexOf(document.activeElement as HTMLButtonElement);
        list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    // When a submenu opens or closes, the width grows or shrinks to fit instead of jumping.
    let width = panel.offsetWidth;
    let resizing: Animation | null = null;
    const resize = new ResizeObserver(() => {
      if (resizing) return;
      const next = panel.offsetWidth;
      if (Math.abs(next - width) > 1 && motionMs() > 0) {
        panel.classList.add("resizing");
        resizing = panel.animate([{ width: `${width}px` }, { width: `${next}px` }], { duration: motionMs(), easing: "cubic-bezier(0.2, 0, 0, 1)" });
        resizing.onfinish = resizing.oncancel = () => {
          resizing = null;
          panel.classList.remove("resizing");
          width = panel.offsetWidth;
        };
      }
      width = next;
    });
    resize.observe(panel);
    const close = () => closeContextMenu();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("wheel", close, { passive: true });
    onCleanup(() => {
      resize.disconnect();
      resizing?.cancel();
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("wheel", close);
    });
  });

  return (
    <div ref={panel} class="mw-popover mw-context-menu mw-box" role="menu" tabIndex={-1} classList={{ visible: props.visible }}
      style={{ transform: `translate(${place().x}px, ${place().y}px)` }} onContextMenu={(e) => e.preventDefault()}>
      <Entries entries={props.menu.entries} run={run} />
    </div>
  );
}

function Entries(props: { entries: MenuEntry[]; run: (item: MenuItem) => void }) {
  return (
    <For each={props.entries}>
      {(entry) => entry === "separator"
        ? <div class="mw-menu-separator" role="separator" />
        : "render" in entry ? <div class="mw-menu-content">{entry.render()}</div>
        : "items" in entry ? <Submenu entry={entry} run={props.run} />
        : (
          <button class="mw-menu-item" classList={{ danger: entry.danger }} role="menuitem" disabled={entry.disabled}
            onClick={() => props.run(entry)}>
            <span class="mw-menu-icon"><Show when={entry.icon}><Icon name={entry.icon!} /></Show></span>
            <Show when={entry.swatch}><span class="mw-menu-swatch" style={{ background: entry.swatch }} /></Show>
            {entry.label}
          </button>
        )}
    </For>
  );
}

function Submenu(props: { entry: MenuSubmenu; run: (item: MenuItem) => void }) {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <button class="mw-menu-item" role="menuitem" aria-haspopup="menu" aria-expanded={open()} disabled={props.entry.disabled}
        onClick={() => setOpen(!open())}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") setOpen(e.key === "ArrowRight");
        }}>
        <span class="mw-menu-icon"><Show when={props.entry.icon}><Icon name={props.entry.icon!} /></Show></span>
        {props.entry.label}
        <span class="mw-menu-chevron"><Icon name={open() ? "expanded" : "collapsed"} /></span>
      </button>
      <Collapse open={open()}>
        <div class="mw-submenu mw-scroll-fade" role="menu"><Entries entries={props.entry.items} run={props.run} /></div>
      </Collapse>
    </>
  );
}
