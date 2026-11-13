import type { ClientPlugin } from "../../types";
import { gitbot } from "./gitbot";
import { helpbot } from "./helpbot";
import { automoderator } from "./automoderator";
import { taskbot } from "./taskbot";
import { mediabot } from "./mediabot";

export const botsPlugin: ClientPlugin = {
  manifest: {
    id: "makework.bots",
    icon: "bot",
    name: "Built-in bots",
    version: "1.0.0",
    description: "Automoderator, Task-bot, Help-bot, Git-bot and Media-bot. Add them in Workspace settings > Bots.",
    author: "MakeWork",
  },
  bots: { automoderator, taskbot, helpbot, gitbot, mediabot },
};
