import { Match, Switch } from "solid-js";
import { botState } from "../core/botStatus";
import BotIcon from "./BotIcon";
import { identiconPath } from "./identicon";
import "./Avatar.css";

export interface AvatarUser {
  displayName: string;
  username?: string;
  color?: string;
  // "gen:<seed>" for a generated pattern, or a data:image URL. Empty: generated from the username.
  avatar?: string;
  // Bots without a picture get a generated robot face (seed: id, else username; look colors from botType).
  bot?: boolean;
  botType?: string;
  id?: number | string;
}

const imageUrl = /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i;

// The member's picture, else their generated pattern in their color. Pictures are data URLs only, so showing
// an avatar never fetches anything.
export default function Avatar(props: { user: AvatarUser; size?: number }) {
  const avatar = () => props.user.avatar ?? "";
  const image = () => (imageUrl.test(avatar()) ? avatar() : null);
  const seed = () => (avatar().startsWith("gen:") ? avatar().slice(4) : props.user.username || props.user.displayName);
  const style = () => ({ "--mw-avatar-size": `${props.size ?? 32}px`, "--mw-avatar-color": props.user.color || "var(--mw-text-muted)" });
  return (
    <Switch>
      {/* Bots always get the robot face, whatever picture they carry: only bots look like this. */}
      <Match when={props.user.bot}>
        <span class="mw-avatar mw-avatar-bot" classList={{ off: botState(props.user.id as number | undefined) === "off" }} aria-hidden="true" style={style()}>
          <BotIcon state={botState(props.user.id as number | undefined)} seed={avatar().startsWith("gen:") ? avatar().slice(4) : String(props.user.id ?? props.user.username ?? props.user.displayName)} type={props.user.botType} />
        </span>
      </Match>
      <Match when={!props.user.bot}>
        <span class="mw-avatar mw-box" aria-hidden="true" style={style()}>
          <Switch>
            <Match when={image()}>{(src) => <img src={src()} alt="" draggable={false} />}</Match>
            <Match when={!image()}>
              <svg viewBox="-0.5 -0.5 6 6" shape-rendering="crispEdges"><path d={identiconPath(seed())} /></svg>
            </Match>
          </Switch>
        </span>
      </Match>
    </Switch>
  );
}
