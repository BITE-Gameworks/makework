// The plugins every serverless workspace runs, in the app and on nodes.
import type { MockPlugin } from "../system/backend";
import { channels } from "../system/channels";
import { browser } from "../system/browser";
import { bots } from "../system/bots";
import { chat } from "../system/chat";
import { code } from "../system/code";
import { design } from "../system/design";
import { diagram } from "../system/diagram";
import { docs } from "../system/docs";
import { emoji } from "../system/emoji";
import { files } from "../system/files";
import { git } from "../system/git";
import { members } from "../system/members";
import { nodes } from "../system/nodes";
import { artboard } from "../system/artboard";
import { roles } from "../system/roles";
import { sheets } from "../system/sheets";
import { tasks } from "../system/tasks";
import { voice } from "../system/voice";
import { watch } from "../system/watch";

export const plugins: MockPlugin[] = [channels, members, roles, bots, chat, voice, files, tasks, artboard, design, diagram, docs, code, sheets, git, nodes, browser, emoji, watch];
// Kept in memory on each device instead of the log (short-lived state like voice presence).
export const localPlugins = ["voice"];
