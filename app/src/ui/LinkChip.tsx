import { Show } from "solid-js";
import { linkMenu, openLink, resolveLink } from "../core/links";
import { openContextMenu } from "./contextMenu";
import { Icon } from "../theme/icons";
import "./LinkChip.css";

// A makework:// link shown as the object it points at. Ctrl or middle click opens it in a new tab.
export default function LinkChip(props: { url: string; label?: string }) {
  const info = () => resolveLink(props.url)();
  return (
    <a class="mw-link-chip mw-box" classList={{ missing: info()?.missing }} href={props.url}
      title={info() ? `${info()!.where}${info()!.missing ? " (not found)" : ""}` : props.url}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openLink(props.url, e.ctrlKey || e.metaKey);
      }}
      onAuxClick={(e) => e.button === 1 && (e.preventDefault(), openLink(props.url, true))}
      onContextMenu={(e) => openContextMenu(e, linkMenu(props.url))}>
      <Icon name={info()?.icon ?? "channel-other"} />
      <span class="mw-link-chip-title">
        <Show when={info() && !info()!.missing} fallback={props.label || info()?.title || "..."}>{info()!.title}</Show>
      </span>
    </a>
  );
}
