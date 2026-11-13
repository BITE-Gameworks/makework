// A field that should take the keyboard when it appears (a row being typed on a canvas, a name field that just
// opened). The `autofocus` attribute doesn't do it: browsers honor it once per page, not for fields added later, so
// such a field showed without focus and clicking elsewhere never closed it. Use as a ref: `ref={focusWhenShown}`.
export function focusWhenShown(element: HTMLElement): void {
  requestAnimationFrame(() => {
    if (element.isConnected) element.focus({ preventScroll: true });
  });
}
