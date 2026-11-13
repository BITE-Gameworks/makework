import { createSignal } from "solid-js";
import "./FileDrop.css";

// Files dragged in from outside the app: `over` while they are above the element, `on` the handlers for it.
// The element needs position: relative for the hint.
export function createFileDrop(onDrop: (data: DataTransfer) => void) {
  const [over, setOver] = createSignal(false);
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
  return {
    over,
    on: {
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: (e: DragEvent) => !(e.currentTarget as Node).contains(e.relatedTarget as Node) && setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false);
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        onDrop(e.dataTransfer!);
      },
    },
  };
}

export function DropHint(props: { show: boolean; label: string }) {
  return <div class="mw-drop-hint mw-box" classList={{ visible: props.show }} aria-hidden="true">{props.label}</div>;
}
