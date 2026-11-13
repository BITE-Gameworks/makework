import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { Icon } from "../../../theme/icons";
import Select from "../../../ui/Select";
import { NodeView, type PlayState } from "./Canvas";
import type { Editor } from "./editor";
import { interaction, type DesignNode, type Interaction } from "./model";
import { easings, frameKeyframes, namePaths, reverse } from "./prototype";
import { boxStyle, fillStyle, textStyle } from "./render";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const instant = interaction(null);

interface Overlay {
  key: number;
  frame: number;
  via: Interaction;
}

// Play mode: one page-level frame at a time, fitted to the screen, going to other frames, opening overlays and
// changing component variants as its layers say.
export default function Player(props: { editor: Editor; start: number; onClose: () => void }) {
  const ed = props.editor;
  const [current, setCurrent] = createSignal(props.start);
  const [leaving, setLeaving] = createSignal<{ id: number; onTop: boolean } | null>(null);
  const [trail, setTrail] = createSignal<{ frame: number; via: Interaction }[]>([]);
  const [overlays, setOverlays] = createSignal<Overlay[]>([]);
  // Instances (and mains) shown as another variant: layer -> the variant shown there.
  const [swaps, setSwaps] = createSignal<Record<number, number>>({});
  const [space, setSpace] = createSignal({ width: 0, height: 0 });
  const [pointer, setPointer] = createSignal(false);
  const [hints, setHints] = createSignal(false);
  const play: PlayState = { swaps };
  let root!: HTMLDivElement;
  let stage!: HTMLDivElement;
  let screen: HTMLDivElement | undefined;
  let busy = false;
  let overlayKeys = 0;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  const frames = createMemo(() => ed.children(null).filter((id) => ed.node(id)?.kind === "frame" && ed.node(id)!.props.visible));
  const frame = () => ed.node(current());
  const scale = () => {
    const n = frame();
    if (!n?.width || !n.height) return 1;
    return Math.min(1, space().width / n.width, space().height / n.height);
  };
  const animated = (via: Interaction) => via.transition !== "instant" && via.duration > 0 && !reducedMotion();

  const slot = (id: number) => screen?.querySelector<HTMLElement>(`[data-frame="${id}"]`) ?? null;
  const nodeEl = (parent: Element | null | undefined, id: number) => parent?.querySelector<HTMLElement>(`[data-node="${id}"]`) ?? null;
  const run = (el: Element | null | undefined, frames: Keyframe[] | undefined, via: Interaction, fill: FillMode = "backwards") =>
    el && frames ? el.animate(frames, { duration: via.duration, easing: easings[via.easing], fill }).finished.catch(() => undefined) : Promise.resolve();

  // Layers with the same name path below `from` and `to` move, resize and change color from how they were; new ones
  // fade in. `rootEl` shows `to` now.
  const smartAnimate = (from: number, to: number, rootEl: HTMLElement, via: Interaction) => {
    const name = (id: number) => ed.node(id)?.name ?? "";
    const before = namePaths(from, ed.children, name);
    const pick = (style: JSX.CSSProperties, keys: string[]) =>
      Object.fromEntries(keys.filter((k) => style[k as keyof JSX.CSSProperties] !== undefined).map((k) => [k, String(style[k as keyof JSX.CSSProperties])]));
    const pair = (a: DesignNode, b: DesignNode, el: HTMLElement, isRoot: boolean) => {
      const box = isRoot ? ["width", "height"] : ["width", "height", "transform", "opacity"];
      void run(el, [{ opacity: "1", ...pick(boxStyle(a, ed.resolve), box) }, { opacity: "1", ...pick(boxStyle(b, ed.resolve), box) }], via);
      const fill = el.querySelector(":scope > .design-fill");
      const paint = ["background-image", "border-radius", "box-shadow"];
      if (fill) void run(fill, [pick(fillStyle(a, ed.resolve), paint), pick(fillStyle(b, ed.resolve), paint)], via);
      const text = el.querySelector(":scope .design-text");
      const ink = ["color", "font-size", "letter-spacing"];
      if (text && a.kind === "text" && b.kind === "text") void run(text, [pick(textStyle(a, ed.resolve), ink), pick(textStyle(b, ed.resolve), ink)], via);
    };
    pair(ed.node(from)!, ed.node(to)!, rootEl, true);
    for (const [path, id] of namePaths(to, ed.children, name)) {
      const el = nodeEl(rootEl, id);
      const a = ed.node(before.get(path));
      const b = ed.node(id)!;
      if (!el || !b.props.visible) continue;
      if (a?.props.visible) pair(a, b, el, false);
      else void run(el, [{ opacity: 0 }, { opacity: b.props.opacity }], via);
    }
  };

  // Going to another frame closes overlays and puts components back.
  const go = async (target: number, via: Interaction) => {
    const from = current();
    if (busy || target === from || !ed.node(target)) return;
    batch(() => {
      setOverlays([]);
      setSwaps({});
    });
    if (!animated(via)) return void setCurrent(target);
    busy = true;
    try {
      if (via.transition === "smart") {
        setCurrent(target);
        const el = nodeEl(slot(target), target);
        if (el) smartAnimate(from, target, el, via);
        await new Promise((done) => setTimeout(done, via.duration));
        return;
      }
      const s = scale();
      const k = frameKeyframes(via.transition, via.direction, ed.node(target)!.width * s, ed.node(target)!.height * s);
      batch(() => {
        setLeaving({ id: from, onTop: !!k.leavingOnTop });
        setCurrent(target);
      });
      await Promise.all([run(slot(from), k.leaving, via, "both"), run(slot(target), k.coming, via, "both")]);
    } finally {
      setLeaving(null);
      busy = false;
    }
  };

  const overlayBox = (key: number) => screen?.querySelector<HTMLElement>(`[data-overlay="${key}"] .design-player-overlay-box`);
  const overlayFrames = (o: Overlay) => {
    const n = ed.node(o.frame);
    return n ? frameKeyframes(o.via.transition, o.via.direction, n.width, n.height).coming ?? [{ opacity: 1 }, { opacity: 1 }] : undefined;
  };
  const openOverlay = (via: Interaction): number | undefined => {
    if (via.target === null || !frames().includes(via.target)) return undefined;
    const o = { key: ++overlayKeys, frame: via.target, via };
    setOverlays([...overlays(), o]);
    if (animated(via)) void run(overlayBox(o.key), overlayFrames(o), via);
    return o.key;
  };
  const closing = new Set<number>();
  const closeOverlay = async (key: number) => {
    const o = overlays().find((x) => x.key === key);
    if (!o || closing.has(key)) return;
    closing.add(key);
    if (animated(o.via)) await run(overlayBox(key), [...(overlayFrames(o) ?? [])].reverse(), o.via, "forwards");
    closing.delete(key);
    setOverlays(overlays().filter((x) => x.key !== key));
  };

  // The layer showing a component of the variant set `target` is in: an instance, a main, or one already swapped.
  const hostFor = (target: number, ids: number[]) => {
    const set = ed.node(target)?.parentId;
    return ids.find((id) => {
      const n = ed.node(id);
      const shown = swaps()[id] ?? (n?.props.instanceOf ?? (n?.props.main ? id : null));
      return shown !== null && shown !== undefined && ed.node(shown)?.parentId === set;
    });
  };
  const swapTo = (host: number, target: number, via: Interaction) => {
    const from = swaps()[host] ?? host;
    const own = target === host || target === ed.node(host)?.props.instanceOf;
    const next = { ...swaps() };
    if (own) delete next[host];
    else next[host] = target;
    setSwaps(next);
    const el = nodeEl(screen, host);
    if (!el || !animated(via)) return;
    if (via.transition === "smart") smartAnimate(from, own ? host : target, el, via);
    else void run(el, [{ opacity: 0 }, { opacity: 1 }], via);
  };
  // Changes a component to another variant; returns how to change it back.
  const changeTo = (via: Interaction, ids: number[]) => {
    if (via.target === null || !ed.node(via.target)) return undefined;
    const host = hostFor(via.target, ids);
    if (host === undefined) return undefined;
    const before = swaps()[host] ?? host;
    if (before === via.target) return undefined;
    swapTo(host, via.target, via);
    return () => swapTo(host, before, via);
  };

  // `ids`: the layer the interaction is on and the layers around it, innermost first.
  const perform = (i: Interaction, ids: number[]) => {
    if (i.action === "back") return back();
    if (i.action === "close") return void closeOverlay(overlays().at(-1)?.key ?? -1);
    if (i.action === "overlay") return void openOverlay(i);
    if (i.action === "change-to") return void changeTo(i, ids);
    if (i.target === null || !frames().includes(i.target) || busy || i.target === current()) return;
    setTrail([...trail(), { frame: current(), via: i }]);
    void go(i.target, i);
  };
  const back = () => {
    const top = overlays().at(-1);
    if (top) return void closeOverlay(top.key);
    const last = trail().at(-1);
    if (!last || busy) return;
    setTrail(trail().slice(0, -1));
    void go(last.frame, reverse(last.via));
  };
  const restart = () => {
    setTrail([]);
    batch(() => {
      setOverlays([]);
      setSwaps({});
    });
    void go(props.start, instant);
  };
  const jump = (id: number) => {
    setTrail([...trail(), { frame: current(), via: instant }]);
    void go(id, instant);
  };

  // The layers under the pointer, innermost first, as shown (swapped variants show their own layers).
  const chain = (target: EventTarget | null): number[] => {
    const ids: number[] = [];
    for (let el = (target as Element | null)?.closest<HTMLElement>("[data-node]"); el && screen?.contains(el);
      el = el.parentElement?.closest<HTMLElement>("[data-node]"))
      ids.push(Number(el.dataset.node));
    return ids;
  };
  const first = (ids: number[], trigger: Interaction["trigger"]) => {
    for (const [index, id] of ids.entries()) {
      const found = ed.node(id)?.props.interactions.find((i) => i.trigger === trigger);
      if (found) return { found, around: ids.slice(index) };
    }
    return undefined;
  };

  // A click on nothing that does anything shows what does, for a moment.
  const hotspots = () => {
    for (const el of screen?.querySelectorAll<HTMLElement>("[data-node]") ?? [])
      el.toggleAttribute("data-hotspot", !!ed.node(Number(el.dataset.node))?.props.interactions.some((i) => i.trigger !== "delay"));
    setHints(true);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => setHints(false), 700);
  };

  // "While hovering" lasts while the pointer stays on the component it changed, or on the layer and the overlay it opened.
  const hovering = new Map<number, { revert: () => void; overlay?: number }>();
  let entered = new Set<number>();
  const onPointerOver = (e: PointerEvent) => {
    const ids = chain(e.target);
    for (const [key, h] of [...hovering]) {
      const inOverlay = h.overlay !== undefined && !!(e.target as Element).closest(`[data-overlay="${h.overlay}"]`);
      if (!ids.includes(key) && !inOverlay) {
        hovering.delete(key);
        h.revert();
      }
    }
    const fresh = ids.filter((id) => !entered.has(id));
    entered = new Set(ids);
    setPointer(!!first(ids, "click"));
    const enter = first(fresh, "enter");
    if (enter) perform(enter.found, enter.around);
    const hover = first(fresh, "hover");
    if (!hover) return;
    const { found, around } = hover;
    if (found.action === "change-to" && found.target !== null) {
      const host = hostFor(found.target, around);
      if (host === undefined || hovering.has(host)) return;
      const revert = changeTo(found, around);
      if (revert) hovering.set(host, { revert });
    } else if (found.action === "overlay") {
      if (hovering.has(around[0])) return;
      const key = openOverlay(found);
      if (key !== undefined) hovering.set(around[0], { revert: () => void closeOverlay(key), overlay: key });
    } else perform(found, around);
  };

  // After-delay interactions start when their layer appears (a frame, an overlay, a variant) and run once while shown.
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const fired = new Set<number>();
  const scan = () => {
    const shown = new Map<number, HTMLElement>();
    for (const el of screen?.querySelectorAll<HTMLElement>(`[data-frame="${current()}"] [data-node], [data-overlay] [data-node]`) ?? [])
      shown.set(Number(el.dataset.node), el);
    for (const [id, timer] of timers) {
      if (shown.has(id)) continue;
      clearTimeout(timer);
      timers.delete(id);
    }
    for (const id of fired) if (!shown.has(id)) fired.delete(id);
    for (const [id, el] of shown) {
      const i = ed.node(id)?.props.interactions.find((x) => x.trigger === "delay");
      if (!i || timers.has(id) || fired.has(id)) continue;
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        fired.add(id);
        if (el.isConnected) perform(i, chain(el));
      }, Math.max(0, i.delay)));
    }
  };
  createEffect(on([current, swaps, overlays], () => {
    entered = new Set();
    queueMicrotask(scan);
  }));

  onMount(() => {
    root.focus();
    const observer = new ResizeObserver(([entry]) => setSpace({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(stage);
    onCleanup(() => {
      observer.disconnect();
      clearTimeout(hintTimer);
      timers.forEach(clearTimeout);
    });
  });

  const shown = () => (leaving() ? [leaving()!.id, current()] : [current()]);
  const size = (id: number) => {
    const n = ed.node(id);
    return n ? { width: `${n.width * scale()}px`, height: `${n.height * scale()}px` } : {};
  };
  // Where an overlay sits in the frame shown, in the frame's units.
  const overlayAt = (o: Overlay) => {
    const n = ed.node(o.frame);
    const f = frame();
    if (!n || !f) return { x: 0, y: 0 };
    const y = o.via.overlay === "top" ? 0 : o.via.overlay === "bottom" ? f.height - n.height : (f.height - n.height) / 2;
    return { x: (f.width - n.width) / 2, y };
  };
  const placed = (id: number) => (
    <Show when={ed.node(id)}>
      {(n) => (
        <div style={{ transform: `translate(${-n().x}px, ${-n().y}px)` }}>
          <NodeView editor={ed} id={id} onFinishText={() => undefined} play={play} />
        </div>
      )}
    </Show>
  );

  return (
    <div ref={root} class="design-player mw-fade-in" tabIndex={-1} role="dialog" aria-label="Prototype"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") props.onClose();
        else if (e.key === "ArrowLeft" || e.key === "Backspace") back();
        else if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.metaKey) restart();
      }}>
      <header class="design-player-bar">
        <button class="icon-button" title="Back (Left arrow)" aria-label="Back" disabled={trail().length === 0 && overlays().length === 0} onClick={back}>
          <Icon name="back" />
        </button>
        <button class="icon-button" title="Restart (R)" aria-label="Restart" onClick={restart}><Icon name="refresh" /></button>
        <Select class="design-player-frames" label="Frame shown" value={current()} search={frames().length > 12}
          options={frames().map((id) => ({ value: id, label: ed.node(id)!.name }))} onChange={jump} />
        <span class="design-spacer" />
        <button class="icon-button" title="Stop playing (Escape)" aria-label="Stop playing" onClick={props.onClose}><Icon name="close" /></button>
      </header>
      <div ref={stage} class="design-player-stage" role="presentation" classList={{ pointer: pointer(), hints: hints() }}
        onPointerOver={onPointerOver}
        onPointerLeave={() => {
          entered = new Set();
          setPointer(false);
          for (const h of hovering.values()) h.revert();
          hovering.clear();
        }}
        onClick={(e) => {
          const hit = first(chain(e.target), "click");
          if (hit) perform(hit.found, hit.around);
          else hotspots();
        }}>
        <Show when={frame()} fallback={<p class="design-hint">That frame is gone.</p>}>
          <div ref={screen} class="design-player-screen" style={size(current())}>
            <For each={shown()}>
              {(id) => (
                <div class="design-player-slot" data-frame={id} classList={{ top: leaving()?.id === id && leaving()!.onTop }} style={size(id)}>
                  <div class="design-player-content" style={{ transform: `scale(${scale()})` }}>{placed(id)}</div>
                </div>
              )}
            </For>
            <For each={overlays()}>
              {(o) => (
                <div class="design-player-overlay" data-overlay={o.key}>
                  <div class="design-player-backdrop mw-fade-in" role="presentation" classList={{ dark: o.via.backdrop }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (o.via.closeOutside && o.key === overlays().at(-1)?.key) void closeOverlay(o.key);
                    }} />
                  <div class="design-player-content" style={{ transform: `scale(${scale()})` }}>
                    <div class="design-player-overlay-place" style={{ transform: `translate(${overlayAt(o).x}px, ${overlayAt(o).y}px)` }}>
                      <div class="design-player-overlay-box"
                        style={{ width: `${ed.node(o.frame)?.width ?? 0}px`, height: `${ed.node(o.frame)?.height ?? 0}px` }}>
                        {placed(o.frame)}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
