// Where a character position is drawn inside a textarea, measured with a hidden copy that wraps the same way.
const copied = [
  "boxSizing", "width", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontFamily", "fontSize", "fontWeight", "fontStyle",
  "lineHeight", "letterSpacing", "tabSize", "textTransform", "wordSpacing", "textIndent",
] as const;

let mirror: HTMLDivElement | null = null;

// The position's top left and line height in px, relative to the textarea's border box, after its scrolling.
export function caretPoint(el: HTMLTextAreaElement, index: number): { left: number; top: number; height: number } {
  mirror ??= document.body.appendChild(Object.assign(document.createElement("div"), { ariaHidden: "true" }));
  const style = getComputedStyle(el);
  for (const key of copied) mirror.style[key] = style[key];
  Object.assign(mirror.style, {
    position: "fixed", left: "-10000px", top: "0", visibility: "hidden", overflow: "hidden",
    whiteSpace: "pre-wrap", overflowWrap: "break-word", width: `${el.offsetWidth}px`,
  });
  mirror.textContent = el.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = el.value.slice(index, index + 1) || ".";
  mirror.append(marker);
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4;
  return { left: marker.offsetLeft - el.scrollLeft, top: marker.offsetTop - el.scrollTop, height: lineHeight };
}
