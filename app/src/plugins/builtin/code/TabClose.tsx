import type { JSX } from "solid-js";

// The close mark at the end of a file tab or a terminal tab. A span with the button role, since the tab itself is
// a button and a button can't hold another. It is a tab stop of its own; Enter and Space press it. The press never
// reaches the tab (which would select it).
export default function TabClose(props: { onClose: () => void; children: JSX.Element }) {
  return (
    <span class="code-tab-end" role="button" tabIndex={0} aria-label="Close" title="Close"
      onClick={(event) => {
        event.stopPropagation();
        props.onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }}>
      {props.children}
    </span>
  );
}
