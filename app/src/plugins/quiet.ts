// A kept view that is hidden does no work (spec: quiet while hidden): work asked for while hidden is only
// remembered, and running it happens once, when the view shows again. A view whose first load was due while
// hidden (its first mount, a key change) goes through the same door, so showing it does that first load.
// Shared by the live store (plugins/live.ts) and the generic describe-based view (GenericView.tsx).
import { createEffect, on, type Accessor } from "solid-js";

export function createQuiet(active: Accessor<boolean>): { run: (work: () => void) => void } {
  let pending: (() => void) | undefined;
  createEffect(on(active, (shown) => {
    if (!shown || !pending) return;
    const work = pending;
    pending = undefined;
    work();
  }, { defer: true }));
  return {
    run(work) {
      if (active()) work();
      else pending = work;
    },
  };
}
