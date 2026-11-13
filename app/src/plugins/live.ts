import { createEffect, on, onCleanup, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { PluginClient } from "../api/client";
import { afterSlides } from "../ui/transitions";
import { createQuiet } from "./quiet";

export interface Loaded<T> {
  value: T;
  loaded: boolean;
  error: unknown;
}

// Keeps the latest result in a store, refetched when key changes and on the plugin's change events.
// reconcile by id keeps unchanged items as the same objects, so lists only re-render (and animate) what
// actually changed. Answers to older requests are dropped, so a burst of events can't leave stale data.
// A hidden kept view does no work: events only mark it changed, and showing it refetches once (plugins/quiet.ts).
export function createLive<T>(api: PluginClient, initial: T, key: Accessor<unknown>, fetch: () => Promise<T>): Loaded<T> & { refresh: () => Promise<void> } {
  const [state, setState] = createStore<Loaded<T>>({ value: initial, loaded: false, error: undefined });
  let latest = 0;
  // A view's first data (and the first after its key changed) is asked for once the view's slide in ended
  // (ui/transitions.ts): rendered mid-slide, a big channel's content took the slide's frames, and in a serverless
  // workspace the query itself runs in the page too (mesh-test s15). Later changes show at once.
  let first = true;
  const quiet = createQuiet(() => api.active?.() ?? true);
  const load = async () => {
    const request = ++latest;
    const waits = first;
    try {
      if (waits) await afterSlides();
      if (request !== latest) return;
      const value = await fetch();
      if (request !== latest) return;
      first = false;
      setState("value", reconcile(value, { key: "id" }));
      setState({ loaded: true, error: undefined });
    } catch (error) {
      if (request === latest) setState({ loaded: true, error });
    }
  };
  // A view that first mounted hidden runs its (never loaded) key effect through `quiet` too.
  const invalidate = () => quiet.run(() => void load());
  createEffect(on(key, () => {
    first = true;
    invalidate();
  }));
  onCleanup(api.onEvent(invalidate));
  return {
    get value() { return state.value; },
    get loaded() { return state.loaded; },
    get error() { return state.error; },
    refresh: load,
  };
}
