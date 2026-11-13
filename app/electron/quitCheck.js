// Whether to go on with a quit (background.js). A deliberate quit asks first while new uploads haven't reached a node
// (src/p2p/deliveries.ts): the node pulls them from this computer after the post, and quitting before it had them left
// big files missing or incomplete there. A shutdown, a signal or the session ending never asks (`force`):
// nobody is there to answer.
// `ask(win)`: how many uploads are on their way (the page's count, 0 when it doesn't answer); `show(win, options)`:
// Electron's `dialog.showMessageBox`, resolving with the button picked.
export function createQuitCheck({ ask, show }) {
  let forced = false;
  let asking = null;
  return {
    force() {
      forced = true;
    },
    // True to quit; quits that come while the question is open share its answer.
    confirm(win) {
      if (forced) return Promise.resolve(true);
      asking ??= (async () => {
        const count = await ask(win);
        if (count === 0) return true;
        const { response } = await show(win, {
          type: "warning", title: "MakeWork", noLink: true, buttons: ["Keep running", "Quit anyway"], defaultId: 0, cancelId: 0,
          message: count === 1 ? "1 new file hasn't reached the node yet" : `${count} new files haven't reached the node yet`,
          detail: "The node copies new uploads from this computer. If you quit now, it gets the rest the next time MakeWork runs here.",
        });
        return response === 1;
      })().finally(() => (asking = null));
      return asking;
    },
  };
}
