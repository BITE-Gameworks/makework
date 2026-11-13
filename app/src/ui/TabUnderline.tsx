import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";

// A line under the active tab of the row it is placed in (the tab with aria-current="true"), sliding to the next
// one when `active` changes. Its width is set rather than scaled: a 1px line scaled up came out too short at
// fractional display scaling, since it is drawn one device pixel wide first.
export default function TabUnderline(props: { active: unknown }) {
  let line!: HTMLSpanElement;
  const [box, setBox] = createSignal<{ x: number; width: number } | null>(null);
  const [ready, setReady] = createSignal(false);
  const place = () => {
    const tab = line.parentElement?.querySelector<HTMLElement>("[aria-current='true']");
    const row = line.parentElement!.getBoundingClientRect();
    const at = tab?.getBoundingClientRect();
    if (at && (at.left < row.left || at.right > row.right)) tab!.scrollIntoView({ inline: "nearest", block: "nearest" });
    // A row that scrolls sideways (settings tabs in a narrow window) moves the line with its tabs.
    setBox(at ? { x: at.left - row.left + line.parentElement!.scrollLeft, width: at.width } : null);
  };
  createEffect(on(() => props.active, () => requestAnimationFrame(place)));
  onMount(() => {
    // The first placement appears in place; later ones slide.
    requestAnimationFrame(() => {
      place();
      requestAnimationFrame(() => setReady(true));
    });
    const observer = new ResizeObserver(place);
    observer.observe(line.parentElement!);
    // A mouse wheel scrolls a row that overflows sideways, so its hidden scrollbar doesn't cut off the last tabs.
    const row = line.parentElement!;
    const wheel = (e: WheelEvent) => {
      if (row.scrollWidth <= row.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      row.scrollLeft += e.deltaY;
    };
    row.addEventListener("wheel", wheel, { passive: false });
    onCleanup(() => {
      observer.disconnect();
      row.removeEventListener("wheel", wheel);
    });
  });
  return (
    <span ref={line} class="tab-underline" classList={{ ready: ready(), visible: box() !== null }} aria-hidden="true"
      style={{ transform: `translateX(${box()?.x ?? 0}px)`, width: `${box()?.width ?? 0}px` }} />
  );
}
