import { solidView } from "../../solid";
import type { ClientPlugin } from "../../types";
import { tasksSkills, tasksIndex } from "./agentSkills";
import TasksView from "./TasksView";
import { getTask } from "./data";
import type { ApiValue } from "../../../api/types";
import { decodeEmoji } from "../../../markdown/emoji";

export const tasksPlugin: ClientPlugin = {
  manifest: {
    id: "makework.tasks",
    icon: "channel-tasks",
    name: "Tasks",
    version: "0.2.0",
    description: "Task boards with your own columns, tags, comments, reactions and drag and drop.",
    author: "MakeWork",
  },
  agentSkills: { tasks: [...tasksSkills] },
  agentIndex: { tasks: tasksIndex },
  channelViews: { tasks: solidView(TasksView) },
  links: {
    tasks: {
      async resolve(target, ctx) {
        if (target.kind !== "task") return null;
        const task = await getTask(ctx.api, Number(target.id));
        return { title: task.title, icon: task.doneAt ? "check" : "channel-tasks" };
      },
      async search(query, ctx) {
        const { tasks } = await ctx.api.call<{ tasks: Record<string, ApiValue>[] }>("list-board", { channel_id: ctx.channel.id });
        return tasks.filter((t) => decodeEmoji(String(t.title)).toLowerCase().includes(query)).slice(0, 5).map((t) => ({
          kind: "task", id: Number(t.id), title: decodeEmoji(String(t.title)), icon: t.done_at ? "check" : "channel-tasks",
        }));
      },
    },
  },
};
