import { Show } from "solid-js";
import type { UserInfo } from "../plugins/types";
import Avatar from "./Avatar";
import "./RemoteCursor.css";

// Another member's pointer on a board, in their color with their name. `at` is in px from the board's top left.
export default function RemoteCursor(props: { at: { x: number; y: number }; user: UserInfo }) {
  return (
    <div class="remote-cursor" style={{
      "--who": props.user.color || "var(--mw-text-muted)",
      transform: `translate(${props.at.x}px, ${props.at.y}px)`,
    }}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 1 L1 13 L4.5 9.5 L7 15 L9 14 L6.5 8.5 L11.5 8.5 Z" /></svg>
      <Show when={props.user.bot}>
        <span class="remote-cursor-avatar"><Avatar user={props.user} size={26} /></span>
      </Show>
      <span class="remote-cursor-name" classList={{ "with-avatar": props.user.bot }}>{props.user.displayName}</span>
    </div>
  );
}
