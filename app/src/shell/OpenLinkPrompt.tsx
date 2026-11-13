import { createSignal, Show } from "solid-js";
import { continueInBrowser, linkToAsk, openInDesktopApp } from "../core/openLinks";
import { downloadPage } from "../core/updates";
import Dialog from "../ui/Dialog";
import "./OpenLinkPrompt.css";

// A MakeWork link opened in a browser: open it in the desktop app (the browser asks first) or stay in the web app.
export default function OpenLinkPrompt() {
  const [tried, setTried] = createSignal(false);
  const stay = () => {
    const url = linkToAsk();
    if (url) continueInBrowser(url);
  };
  return (
    <Dialog open={!!linkToAsk()} title="Open this MakeWork link" onClose={stay}>
      <div class="open-link-prompt">
        <p class="hint">
          <Show when={tried()} fallback="Open it in the desktop app, or here in your browser.">
            <span class="mw-fade-in">
              Didn't open? Accept your browser's question, or <a href={downloadPage} target="_blank" rel="noopener noreferrer">get the desktop app</a>.
            </span>
          </Show>
        </p>
        <div class="open-link-actions">
          <button type="button" class="mw-button mw-box" onClick={stay}>Continue in the browser</button>
          <button type="button" class="mw-button primary mw-box" onClick={() => { openInDesktopApp(linkToAsk()!); setTried(true); }}>
            {tried() ? "Try again" : "Open in the desktop app"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
