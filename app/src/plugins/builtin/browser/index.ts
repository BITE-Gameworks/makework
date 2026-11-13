import { solidView } from "../../solid";
import type { ClientPlugin } from "../../types";
import { browserSkills } from "./agentSkills";
import BrowserView from "./BrowserView";

export const browserPlugin: ClientPlugin = {
  manifest: {
    id: "makework.browser",
    icon: "channel-browser",
    name: "Browser",
    version: "1.0.0",
    description: "A web browser the channel's members use together: same page, clicks, typing, scrolling and videos. Desktop app only.",
    author: "MakeWork",
  },
  agentSkills: { browser: [...browserSkills] },
  channelViews: { browser: solidView(BrowserView) },
};
