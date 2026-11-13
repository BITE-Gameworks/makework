// The messages a message list shows (chat channels, threads, private conversations): a screenful of the newest at
// once and nothing more on its own, so the list and its scrollbar hold still once it opened. Older messages come only
// after the reader scrolled up themselves (scrollPlace.ts `onReaderUp`), in pieces (ui/progressive.ts) as the top
// comes near. A list too short to scroll yet takes more until it fills the view. A list coming back to a reading
// place (scrollPlace.ts) shows down to its message at once, so it can be put back where it was.
import { createProgressive, watchNear, type Progressive } from "../ui/progressive";
import { rememberedPlace } from "./scrollPlace";

export interface MessageWindow<T> extends Progressive<T> {
  // Call on mount with an element above the messages and the scroller: older messages come as it gets near, once the
  // reader scrolled up. Returns stop.
  watch(top: Element, scroller: Element): () => void;
  // The reader scrolled up: from now on, until the list is left, older messages come as the top comes near.
  readerUp(): void;
}

// The smallest a message is on screen (one line of a grouped message), for how many make a screenful.
const smallestMessagePx = 20;
const screenful = () => Math.max(30, Math.ceil((typeof window === "undefined" ? 0 : window.innerHeight) / smallestMessagePx));

// `key` is the list's scroll key (scrollPlace.ts).
export function createMessageWindow<T extends { id: unknown }>(messages: () => readonly T[], key: string): MessageWindow<T> {
  const progressive = createProgressive(messages, {
    from: "end", limit: 0,
    first: () => {
      const id = rememberedPlace(key);
      const list = messages();
      const at = id === undefined ? -1 : list.findIndex((m) => String(m.id) === id);
      return Math.max(screenful(), at < 0 ? 0 : list.length - at);
    },
  });
  let up = false;
  let wake: (() => void) | undefined;
  return {
    ...progressive,
    watch: (top, scroller) => {
      // A scroller that isn't laid out (0 high) is no list too short to scroll.
      const short = () => scroller.clientHeight > 0 && scroller.scrollHeight <= scroller.clientHeight;
      const watcher = watchNear(top, scroller, () => (up || short()) && progressive.more());
      wake = watcher.wake;
      return () => {
        watcher.stop();
        if (wake === watcher.wake) wake = undefined;
      };
    },
    readerUp() {
      if (up) return;
      up = true;
      wake?.();
    },
  };
}
