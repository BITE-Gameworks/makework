import type { JSX } from "solid-js";
import { Icon } from "../theme/icons";
import "./Disclosure.css";

// A label with an arrow that opens and closes a section below it (put that in a Collapse).
export default function Disclosure(props: { open: boolean; onToggle: () => void; class?: string; children: JSX.Element }) {
  return (
    <button type="button" class={`mw-disclosure ${props.class ?? ""}`} classList={{ open: props.open }} aria-expanded={props.open} onClick={props.onToggle}>
      <span class="mw-disclosure-arrow"><Icon name="expanded" size={14} /></span>
      {props.children}
    </button>
  );
}
