import { For, Show, createMemo } from "solid-js";
import type { CursorPoint } from "../core/presence";
import type { UserInfo } from "../plugins/types";
import RemoteCursor from "./RemoteCursor";

type Cursor = { userId: number; x: number; y: number };

// Every other member's pointer over a view (`context.cursors.others`). `toScreen` maps the view's coordinates to
// px in the board.
export default function RemoteCursors(props: {
  others: () => Cursor[];
  user: (id: number) => UserInfo;
  toScreen: (at: CursorPoint) => CursorPoint;
}) {
  const ids = createMemo(() => props.others().map((c) => c.userId), [], { equals: sameIds });
  const at = (id: number) => props.others().find((c) => c.userId === id);
  return (
    <For each={ids()}>
      {(id) => (
        <Show when={at(id)}>
          {(cursor) => <RemoteCursor at={props.toScreen(cursor())} user={props.user(id)} />}
        </Show>
      )}
    </For>
  );
}

const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((id, i) => id === b[i]);
