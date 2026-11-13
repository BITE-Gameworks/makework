import { For } from "solid-js";

const keys: [string, string][] = [
  ["V", "Move"], ["H", "Hand"], ["F", "Frame"], ["R", "Rectangle"], ["O", "Ellipse"], ["L", "Line"], ["P", "Pen"], ["Shift + P", "Pencil"], ["T", "Text"],
  ["Pen: click / drag", "Corner point / curve"], ["Pen: click the first point", "Close the shape"],
  ["Pen: Enter, Esc or double click", "Finish an open path"], ["Pencil: end at the start", "Close the shape"],
  ["Double click a path", "Edit its points"], ["Ctrl while dragging a handle", "Move it alone"],
  ["Double click a point", "Corner / smooth"], ["Shift + H / V", "Flip horizontal / vertical"], ["Alt + R", "Rotate 90°"], ["N", "Add a note"],
  ["Space", "Pan while held"], ["Wheel", "Pan (Shift: sideways)"], ["Ctrl + wheel", "Zoom"], ["+ / -", "Zoom in / out"],
  ["Shift + 1", "Fit everything"], ["Shift + 2", "Zoom to selection"], ["Shift + 0", "Actual size"],
  ["Ctrl + click", "Select deep inside"], ["Double click", "Edit text, or select inside"], ["Right click > Edit text", "Edit text"],
  ["Enter", "Edit text, or select inside"], ["Shift + Enter", "Select parent"], ["Esc", "Back to Move, or deselect"],
  ["Ctrl + A", "Select all next to it"], ["Arrows", "Nudge 1 (Shift: 10)"],
  ["Shift while dragging", "Keep ratio, straight lines, 15° turns"], ["Alt while resizing", "From the center"],
  ["Alt while moving", "No snapping"],
  ["Ctrl + C / X / V", "Copy, cut, paste"], ["Ctrl + D", "Duplicate"], ["F2", "Rename"], ["Del", "Delete"],
  ["Ctrl + G", "Group"], ["Ctrl + Shift + G", "Ungroup"], ["Ctrl + Alt + G", "Frame selection"], ["Ctrl + ] / [", "Forward / backward"], ["Ctrl + Shift + ] / [", "To front / back"],
  ["Ctrl + Shift + H", "Show / hide"], ["Ctrl + Shift + L", "Lock / unlock"], ["Ctrl + Z", "Undo"], ["Ctrl + Shift + Z", "Redo"],
  ["Ctrl + Alt + K", "Create component"], ["Ctrl + Alt + B", "Detach instance"], ["Ctrl + Alt + Enter", "Play"],
  ["Play: Left arrow / R / Esc", "Back / restart / stop"],
];

// The design view's keyboard and mouse shortcuts, shown in the side panel.
export default function Shortcuts() {
  return (
    <dl class="design-shortcuts mw-scroll-fade">
      <For each={keys}>{([k, what]) => <><dt>{k}</dt><dd>{what}</dd></>}</For>
    </dl>
  );
}
