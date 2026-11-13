import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { createPresence } from "./presence";
import "./Popover.css";

const gap = 6;
const margin = 4;

// Every Popover drawn now: where it is anchored, and whether it is open (not just playing its closing animation).
const drawn = new Map<Element, { anchor: () => Element; open: () => boolean }>();

// Whether `other` (a popover panel) was opened from inside `panel`: its anchor is in `panel`, or in a popover that was.
function opensFrom(panel: Element, other: Element | null): boolean {
  const entry = other && other !== panel ? drawn.get(other) : undefined;
  if (!entry) return false;
  const anchor = entry.anchor();
  if (panel.contains(anchor)) return true;
  return opensFrom(panel, anchor.closest(".mw-popover"));
}

// A small floating panel next to its anchor (the element the Popover is placed in). It is drawn at the top
// level so scrolling lists can't clip it, on the preferred side if it fits there, else on the other side.
// Closes on outside click or Escape.
export default function Popover(props: {
  open: boolean;
  onClose: () => void;
  placement?: "above" | "below";
  align?: "start" | "end";
  label: string;
  children: JSX.Element;
}) {
  const presence = createPresence(() => props.open);
  let marker!: HTMLSpanElement;
  let panel: HTMLDivElement | undefined;
  const [place, setPlace] = createSignal<{ left: number; top: number; above: boolean } | null>(null);
  const anchor = () => marker.parentElement!;

  const position = () => {
    if (!panel) return;
    const a = anchor().getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const roomAbove = a.top - gap - margin;
    const roomBelow = innerHeight - a.bottom - gap - margin;
    const wantAbove = props.placement !== "below";
    const above = wantAbove ? roomAbove >= height || roomAbove > roomBelow : !(roomBelow >= height || roomBelow > roomAbove);
    const top = above ? Math.max(margin, a.top - gap - height) : Math.min(innerHeight - margin - height, a.bottom + gap);
    const left = props.align === "end" ? a.right - width : a.left;
    setPlace({ left: Math.max(margin, Math.min(innerWidth - margin - width, left)), top, above });
  };

  createEffect(() => {
    if (!presence.mounted()) return setPlace(null);
    requestAnimationFrame(position);
    if (!props.open) return;
    // A popover opened from inside this one (a Select's list, anchored in this panel) belongs to it: a click there is
    // inside, and it takes Escape first while it is open. One merely later in the page (unrelated, or still fading
    // out after closing) doesn't.
    const nested = (other: Element | null) => !!panel && opensFrom(panel, other);
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      const inner = target instanceof Element && nested(target.closest(".mw-popover"));
      if (!anchor().contains(target) && !panel?.contains(target) && !inner) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || [...drawn].some(([other, entry]) => entry.open() && nested(other))) return;
      e.stopPropagation();
      props.onClose();
    };
    // Content that grows or shrinks while open (a note appearing) keeps the panel beside its anchor.
    const resized = new ResizeObserver(() => position());
    if (panel) resized.observe(panel);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    onCleanup(() => {
      resized.disconnect();
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    });
  });

  return (
    <>
      <span ref={marker} hidden />
      <Show when={presence.mounted()}>
        <Portal>
          <div ref={(el) => {
            panel = el;
            drawn.set(el, { anchor, open: () => props.open });
            onCleanup(() => drawn.delete(el));
          }} class="mw-popover mw-box" role="dialog" aria-label={props.label}
            classList={{ visible: presence.visible() && place() !== null, above: place()?.above ?? props.placement !== "below" }}
            style={{
              position: "fixed", left: `${place()?.left ?? 0}px`, top: `${place()?.top ?? 0}px`, bottom: "auto", right: "auto",
              visibility: place() ? "visible" : "hidden",
            }}>
            {props.children}
          </div>
        </Portal>
      </Show>
    </>
  );
}
