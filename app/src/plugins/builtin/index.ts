// Every built-in client plugin, in one list: the app registers them all at start. Views and data live next to
// each plugin in builtin/<name>/; channel types and icons in builtin/channelTypes.ts.
import { registerBuiltIn } from "../registry";
import { agentsPlugin } from "./agents";
import { botsPlugin } from "./bots";
import { browserPlugin } from "./browser";
import { codePlugin } from "./code";
import { channelTypesPlugin } from "./channelTypes";
import { chatPlugin } from "./chat";
import { designPlugin } from "./design";
import { diagramPlugin } from "./diagram";
import { docsPlugin } from "./docs";
import { filesPlugin } from "./files";
import { gitPlugin } from "./git";
import { tasksPlugin } from "./tasks";
import { sheetsPlugin } from "./sheets";
import { viewersPlugin } from "../../viewers";
import { voicePlugin } from "../../voice/plugin";

export function registerBuiltInPlugins(): void {
  registerBuiltIn(channelTypesPlugin);
  registerBuiltIn(chatPlugin);
  registerBuiltIn(voicePlugin);
  registerBuiltIn(viewersPlugin);
  registerBuiltIn(filesPlugin);
  registerBuiltIn(tasksPlugin);
  registerBuiltIn(sheetsPlugin);
  registerBuiltIn(browserPlugin);
  registerBuiltIn(designPlugin);
  registerBuiltIn(diagramPlugin);
  registerBuiltIn(docsPlugin);
  registerBuiltIn(codePlugin);
  registerBuiltIn(gitPlugin);
  registerBuiltIn(botsPlugin);
  registerBuiltIn(agentsPlugin, { defaultOff: true });
}