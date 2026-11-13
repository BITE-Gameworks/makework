// Play mode's transitions between frames: keyframes for the frame going away and the one coming in, the way back,
// and the layers smart animate pairs up.
import type { Direction, Easing, Interaction, Transition } from "./model";

export const triggerLabels: Record<Interaction["trigger"], string> = {
  click: "On click", enter: "Mouse enter", hover: "While hovering", delay: "After delay",
};
export const actionLabels: Record<Interaction["action"], string> = {
  navigate: "Go to", back: "Back", overlay: "Open overlay", close: "Close overlay", "change-to": "Change to",
};
export const overlayLabels: Record<Interaction["overlay"], string> = { center: "Center", top: "Top", bottom: "Bottom" };
export const transitionLabels: Record<Transition, string> = {
  instant: "Instant", dissolve: "Dissolve", "move-in": "Move in", "move-out": "Move out", push: "Push", "slide-in": "Slide in",
  smart: "Smart animate",
};
export const directionLabels: Record<Direction, string> = { left: "Left", right: "Right", up: "Up", down: "Down" };
export const easingLabels: Record<Easing, string> = {
  "ease-out": "Ease out", "ease-in": "Ease in", "ease-in-out": "Ease in and out", linear: "Linear", bouncy: "Bouncy",
};
export const easings: Record<Easing, string> = {
  "ease-out": "cubic-bezier(0, 0, 0.2, 1)", "ease-in": "cubic-bezier(0.4, 0, 1, 1)", "ease-in-out": "cubic-bezier(0.4, 0, 0.2, 1)",
  linear: "linear", bouncy: "cubic-bezier(0.34, 1.56, 0.64, 1)",
};
export const directional = (t: Transition) => t === "move-in" || t === "move-out" || t === "push" || t === "slide-in";

const opposite: Record<Direction, Direction> = { left: "right", right: "left", up: "down", down: "up" };

// Going back plays the way there backwards.
export function reverse(i: Interaction): Interaction {
  const transition: Transition = i.transition === "move-in" ? "move-out" : i.transition === "move-out" ? "move-in"
    : i.transition === "slide-in" ? "dissolve" : i.transition;
  return { ...i, transition, direction: opposite[i.direction] };
}

// Where a frame moving in that direction starts: "left" comes in from the right.
function from(d: Direction, width: number, height: number) {
  return { left: [width, 0], right: [-width, 0], up: [0, height], down: [0, -height] }[d];
}
const at = (x: number, y: number) => `translate(${x}px, ${y}px)`;

export interface FrameKeyframes {
  leaving?: Keyframe[];
  coming?: Keyframe[];
  // The frame going away stays on top (move out).
  leavingOnTop?: boolean;
}

// `width`/`height`: the screen the frames are shown in.
export function frameKeyframes(t: Transition, d: Direction, width: number, height: number): FrameKeyframes {
  const [x, y] = from(d, width, height);
  switch (t) {
    case "dissolve": return { coming: [{ opacity: 0 }, { opacity: 1 }] };
    case "move-in": return { coming: [{ transform: at(x, y) }, { transform: at(0, 0) }] };
    case "move-out": return { leaving: [{ transform: at(0, 0) }, { transform: at(-x, -y) }], leavingOnTop: true };
    case "push": return { coming: [{ transform: at(x, y) }, { transform: at(0, 0) }], leaving: [{ transform: at(0, 0) }, { transform: at(-x, -y) }] };
    case "slide-in": return { coming: [{ transform: at(x * 0.3, y * 0.3), opacity: 0 }, { transform: at(0, 0), opacity: 1 }] };
    default: return {};
  }
}

// Smart animate pairs layers by their names on the way down from the frame ("Card/Title"); the first of equal names wins.
export function namePaths(frame: number, children: (id: number) => number[], name: (id: number) => string): Map<string, number> {
  const paths = new Map<string, number>();
  const walk = (parent: number, prefix: string) => {
    for (const id of children(parent)) {
      const path = `${prefix}${name(id)}`;
      if (!paths.has(path)) paths.set(path, id);
      walk(id, `${path}/`);
    }
  };
  walk(frame, "");
  return paths;
}
