// Links opened from outside MakeWork: a makework:// link the operating system hands the desktop app, or a web link
// (app.makework.dev/open/...) opened in a browser. They wait until the workspaces are open, then go where they point.
// Whether the channel or object shows is up to the member's permissions there, as for any link.
import { createSignal } from "solid-js";
import { desktop } from "./desktop";
import { parseLink } from "./links";
import { openChannel } from "./navigation";
import { showToast } from "./notices";
import { isPopout } from "./popout";
import { workspaces } from "./workspaces";

const openPath = "/open/";

let ready = false;
const waiting: string[] = [];

function go(url: string): void {
  const ref = parseLink(url);
  if (!ref) showToast("That MakeWork link isn't valid.");
  else if (!workspaces.byId[ref.workspaceId]) showToast("That link is to a workspace you haven't joined.");
  else openChannel(ref.workspaceId, ref.channelId, ref.target);
}

export function receiveLink(url: string): void {
  if (ready) go(url);
  else waiting.push(url);
}

// The main window's workspaces are open (App's start).
export function linksReady(): void {
  ready = true;
  for (const url of waiting.splice(0)) go(url);
}

export function watchDesktopLinks(): void {
  if (!desktop?.takeOpenLinks || isPopout()) return;
  const take = () => void desktop!.takeOpenLinks!().then((urls) => urls.forEach(receiveLink));
  desktop.onOpenLinks?.(take);
  take();
}

// In a browser: the web link this page was opened with, asked about in shell/OpenLinkPrompt before it is opened.
function linkInAddress(): string | null {
  if (desktop || isPopout() || typeof location === "undefined" || !location.pathname.startsWith(openPath)) return null;
  const url = `makework://${location.pathname.slice(openPath.length)}`;
  return parseLink(url) ? url : null;
}

const [asking, setAsking] = createSignal(linkInAddress());
export { asking as linkToAsk };

export function openInDesktopApp(url: string): void {
  location.href = url;
}

export function continueInBrowser(url: string): void {
  history.replaceState(null, "", "/");
  setAsking(null);
  receiveLink(url);
}
