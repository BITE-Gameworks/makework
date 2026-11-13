import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { PluginClient } from "../../src/api/client";
import { createLive } from "../../src/plugins/live";
import { slideEnter } from "../../src/ui/transitions";

// A plugin client whose change events the test sends, and whose `active` (whether its view is shown) the test sets.
function plugin(startActive = true) {
  const [active, setActive] = createSignal(startActive);
  const listeners = new Set<() => void>();
  const api = {
    onEvent: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    active: () => active(),
  } as unknown as PluginClient;
  return { api, change: () => listeners.forEach((l) => l()), show: setActive };
}

// A slide in that ends when the test says so.
function slide() {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  slideEnter(() => 1)({ animate: () => ({ finished }) } as unknown as Element, () => {});
  return finish;
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("a view's live data", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Rendered mid-slide, a big channel's first data took the slide's frames (mesh-test s15).
  it("shows its first data once the view's slide in ended", async () => {
    const { api } = plugin();
    const finish = slide();
    const live = createRoot(() => createLive(api, [] as { id: number }[], () => 1, async () => [{ id: 1 }]));
    await flush();
    expect(live.loaded).toBe(false);
    finish();
    await flush();
    expect(live.loaded).toBe(true);
    expect(live.value).toEqual([{ id: 1 }]);
  });

  // In a serverless workspace the query runs in the page too (MockTransport): a big channel's took 0.4 s.
  it("asks for its first data only once the slide ended", async () => {
    const { api } = plugin();
    const finish = slide();
    let asked = 0;
    createRoot(() => createLive(api, [] as { id: number }[], () => 1, async () => (asked++, [{ id: 1 }])));
    await flush();
    expect(asked).toBe(0);
    finish();
    await flush();
    expect(asked).toBe(1);
  });

  it("shows later changes at once, slide or not", async () => {
    const { api, change } = plugin();
    let rows = [{ id: 1 }];
    const live = createRoot(() => createLive(api, [] as { id: number }[], () => 1, async () => rows));
    await flush();
    expect(live.value).toEqual([{ id: 1 }]);
    const finish = slide();
    rows = [{ id: 1 }, { id: 2 }];
    change();
    await flush();
    expect(live.value).toEqual([{ id: 1 }, { id: 2 }]);
    finish();
  });

  it("waits again after its key changed (another channel, folder or thread)", async () => {
    const { api } = plugin();
    const [key, setKey] = createSignal(1);
    const live = createRoot(() => createLive(api, [] as { id: number }[], key, async () => [{ id: key() }]));
    await flush();
    const finish = slide();
    setKey(2);
    await flush();
    expect(live.value).toEqual([{ id: 1 }]);
    finish();
    await flush();
    expect(live.value).toEqual([{ id: 2 }]);
  });

  // A kept view that is not shown does no work (spec: quiet while hidden).
  it("goes quiet while hidden: events wait, and the next show fetches exactly once", async () => {
    const { api, change, show } = plugin();
    let asked = 0;
    const live = createRoot(() => createLive(api, [] as { id: number }[], () => 1, async () => (asked += 1, [{ id: asked }])));
    await flush();
    expect(asked).toBe(1);
    show(false);
    change();
    change();
    await flush();
    expect(asked).toBe(1);
    expect(live.value).toEqual([{ id: 1 }]);
    show(true);
    await flush();
    expect(asked).toBe(2);
    expect(live.value).toEqual([{ id: 2 }]);
    change();
    await flush();
    expect(asked).toBe(3);
  });

  it("does not fetch again when shown with nothing changed", async () => {
    const { api, show } = plugin();
    let asked = 0;
    createRoot(() => createLive(api, [] as { id: number }[], () => 1, async () => (asked += 1, [])));
    await flush();
    show(false);
    show(true);
    await flush();
    expect(asked).toBe(1);
  });

  it("fetches on each event while shown", async () => {
    const { api, change } = plugin();
    let asked = 0;
    createRoot(() => createLive(api, [] as { id: number }[], () => 1, async () => (asked += 1, [])));
    await flush();
    change();
    await flush();
    change();
    await flush();
    expect(asked).toBe(3);
  });

  // A view rendered while already hidden asks for nothing; its first data still waits for the slide after it shows.
  it("keeps a first load that was due while hidden waiting for the slide after it shows", async () => {
    const { api, show } = plugin(false);
    let asked = 0;
    const live = createRoot(() => createLive(api, [] as { id: number }[], () => 1, async () => (asked += 1, [{ id: 1 }])));
    await flush();
    expect(asked).toBe(0);
    const finish = slide();
    show(true);
    await flush();
    expect(asked).toBe(0);
    finish();
    await flush();
    expect(asked).toBe(1);
    expect(live.value).toEqual([{ id: 1 }]);
  });
});
