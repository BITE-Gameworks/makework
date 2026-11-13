import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterSlides, createViewSwap, slideEnter, slideExit, waitingSlides } from "../../src/ui/transitions";

// An element whose animation ends when the test says so.
function element() {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  return { el: { animate: () => ({ finished }) } as unknown as Element, finish };
}

// The same, with what the in-flow slides touch: connection state, inline style and an animation count.
function fakeElement() {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const animate = vi.fn(() => ({ finished }));
  const el = { animate, isConnected: true, style: {} as CSSStyleDeclaration } as unknown as HTMLElement;
  return { el, finish, animate };
}

const settled = async (promise: Promise<void>) => {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 5));
  return done;
};

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("slides between views", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("are over at once when none runs", async () => {
    expect(await settled(afterSlides())).toBe(true);
  });

  // Out-in, as solid-transition-group runs it: the old view slides out, and a microtask after it ended the new one
  // starts sliding in.
  it("are over only once the slide out and the slide in after it ended", async () => {
    const out = element();
    const into = element();
    slideExit(() => 1)(out.el, () => queueMicrotask(() => slideEnter(() => 1)(into.el, () => {})));
    const waiting = afterSlides();
    expect(await settled(waiting)).toBe(false);
    out.finish();
    expect(await settled(waiting)).toBe(false);
    into.finish();
    expect(await settled(waiting)).toBe(true);
  });

  it("are over at once with reduced motion", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const { el } = element();
    slideEnter(() => 1)(el, () => {});
    expect(await settled(afterSlides())).toBe(true);
  });
});

describe("the kept layer's swap", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A swap over fake elements, recording what happens to each and letting the test end a slide by hand.
  function setup() {
    const events: string[] = [];
    const done = new Map<string, () => void>();
    const names = new Map<Element, string>();
    const label = (el: Element | undefined) => (el ? names.get(el)! : "none");
    const swap = createViewSwap({
      enter: (el, at) => { events.push(`enter:${label(el)}`); done.set(`enter:${label(el)}`, at); },
      exit: (el, at) => { events.push(`exit:${label(el)}`); done.set(`exit:${label(el)}`, at); },
      show: (el) => events.push(`show:${label(el)}`),
      hide: (el) => events.push(`hide:${label(el)}`),
    });
    const fake = (name: string) => {
      const el = { isConnected: true } as unknown as Element;
      names.set(el, name);
      return el;
    };
    return { swap, events, done, fake };
  }

  it("shows the first view at once, like a transition without appear", () => {
    const { swap, events, fake } = setup();
    swap.to(fake("a"));
    expect(events).toEqual(["hide:a", "show:a"]);
  });

  it("slides the old view out, then shows the arriving one and slides it in", async () => {
    const { swap, events, done, fake } = setup();
    swap.to(fake("a"));
    events.length = 0;
    swap.to(fake("b"));
    expect(events).toEqual(["hide:b", "exit:a"]);
    done.get("exit:a")!();
    await settle();
    expect(events).toEqual(["hide:b", "exit:a", "hide:a", "show:b", "enter:b"]);
  });

  it("coalesces a change while the old view is sliding out: only the newest view is shown", async () => {
    const { swap, events, done, fake } = setup();
    swap.to(fake("a"));
    events.length = 0;
    swap.to(fake("b"));
    swap.to(fake("c"));
    expect(events).toEqual(["hide:b", "exit:a", "hide:c"]);
    done.get("exit:a")!();
    await settle();
    expect(events).toEqual(["hide:b", "exit:a", "hide:c", "hide:a", "show:c", "enter:c"]);
  });

  it("brings back the view that was sliding out when it is asked for again", async () => {
    const { swap, events, done, fake } = setup();
    const a = fake("a");
    swap.to(a);
    events.length = 0;
    swap.to(fake("b"));
    swap.to(a);
    expect(events).toEqual(["hide:b", "exit:a"]);
    done.get("exit:a")!();
    await settle();
    expect(events).toEqual(["hide:b", "exit:a", "hide:a", "show:a", "enter:a"]);
  });

  it("drops a waiting view that unmounts, without showing it", async () => {
    const { swap, events, done, fake } = setup();
    swap.to(fake("a"));
    events.length = 0;
    const b = fake("b");
    swap.to(b);
    swap.dropped(b);
    done.get("exit:a")!();
    await settle();
    expect(events).toEqual(["hide:b", "exit:a", "hide:a"]);
    swap.to(fake("c"));
    await settle();
    expect(events.slice(3)).toEqual(["hide:c", "show:c", "enter:c"]);
  });

  it("forgets the shown view when its wrapper unmounts, so the next one shows", async () => {
    const { swap, events, fake } = setup();
    const a = fake("a");
    swap.to(a);
    events.length = 0;
    swap.dropped(a);
    expect(events).toEqual([]);
    swap.to(fake("b"));
    await settle();
    expect(events).toEqual(["hide:b", "show:b", "enter:b"]);
  });

  it("keeps the first view hidden until a slide running under it is over", async () => {
    const { swap, events, fake } = setup();
    const out = element();
    slideExit(() => 1)(out.el, () => {});
    swap.to(fake("a"));
    expect(events).toEqual(["hide:a"]);
    out.finish();
    await settle();
    expect(events).toEqual(["hide:a", "show:a", "enter:a"]);
  });

  // MainView asks the swap for the shown key before the For has mounted a never-visited channel's wrapper
  // (swap.to(undefined) here), so the arriving view can show up once the old one is already gone; it still
  // slides in like any other arrival instead of jumping.
  it("slides in a view whose element arrives only after the old one slid out", async () => {
    const { swap, events, done, fake } = setup();
    swap.to(fake("a"));
    events.length = 0;
    swap.to(undefined);
    expect(events).toEqual(["exit:a"]);
    done.get("exit:a")!();
    await settle();
    expect(events).toEqual(["exit:a", "hide:a"]);
    swap.to(fake("c"));
    await settle();
    expect(events).toEqual(["exit:a", "hide:a", "hide:c", "show:c", "enter:c"]);
  });
});

describe("in-flow slides waiting for a kept view", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the arriving view hidden until the slide under it is over, then slides it in", async () => {
    const flow = waitingSlides(() => 1);
    const leaving = fakeElement();
    slideExit(() => 1)(leaving.el, () => {});
    const arriving = fakeElement();
    flow.enter(arriving.el, () => {});
    expect(arriving.el.style.visibility).toBe("hidden");
    expect(arriving.animate).not.toHaveBeenCalled();
    leaving.finish();
    await settle();
    expect(arriving.el.style.visibility).toBe("");
    expect(arriving.animate).toHaveBeenCalledTimes(1);
    arriving.finish();
  });

  it("drops a view replaced before it ever showed, without sliding it out", async () => {
    const flow = waitingSlides(() => 1);
    const el = fakeElement();
    let entered = false;
    flow.enter(el.el, () => (entered = true));
    let exited = false;
    flow.exit(el.el, () => (exited = true));
    expect(exited).toBe(true);
    expect(entered).toBe(false);
    expect(el.el.style.visibility).toBe("hidden");
    await settle();
    expect(el.animate).not.toHaveBeenCalled();
    expect(entered).toBe(false);
  });

  it("slides a view that has shown out as usual", async () => {
    const flow = waitingSlides(() => 1);
    const el = fakeElement();
    flow.enter(el.el, () => {});
    await settle();
    expect(el.animate).toHaveBeenCalledTimes(1);
    let exited = false;
    flow.exit(el.el, () => (exited = true));
    expect(el.animate).toHaveBeenCalledTimes(2);
    el.finish();
    await settle();
    expect(exited).toBe(true);
  });
});
