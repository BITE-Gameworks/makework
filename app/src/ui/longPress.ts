// A long press on a touch screen opens the same menu as a right click. Android browsers fire `contextmenu` on a long
// press themselves (then this stays out of the way); iOS Safari never does, so the press is turned into one.
const holdMs = 600;
const slopPx = 10;

export function watchLongPress(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | null = null;
  let swallowClick = false;
  const cancel = () => {
    clearTimeout(timer);
    start = null;
  };
  const down = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    cancel();
    start = { x: e.clientX, y: e.clientY };
    const target = e.target as Element;
    timer = setTimeout(() => {
      if (!start || !target.isConnected) return;
      swallowClick = true;
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y, button: 2 }));
      start = null;
    }, holdMs);
  };
  const move = (e: PointerEvent) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > slopPx) cancel();
  };
  // The browser's own long-press menu came first: ours isn't needed.
  const native = (e: Event) => e.isTrusted && cancel();
  // The finger lifting after the menu opened would otherwise click what is under it.
  const click = (e: MouseEvent) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const up = () => {
    if (timer && start) swallowClick = false;
    cancel();
  };
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", cancel, true);
  document.addEventListener("contextmenu", native, true);
  document.addEventListener("click", click, true);
  return () => {
    cancel();
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("contextmenu", native, true);
    document.removeEventListener("click", click, true);
  };
}
