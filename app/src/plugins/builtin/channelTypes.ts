import type { ClientPlugin } from "../types";

// Names and icons for the standard channel types. Their views are separate plugins.
export const channelTypesPlugin: ClientPlugin = {
  manifest: {
    id: "makework.channel-types",
    icon: "layout-grid",
    name: "Standard channel types",
    version: "1.0.0",
    description: "Names and icons for chat, voice, files, tasks, sheets, designs and the other standard channels.",
    author: "MakeWork",
    contributes: {
      channelTypes: [
        { id: "chat", label: "Text chat", description: "Messages, threads, polls and pins", icon: "channel-chat", loader: "messages" },
        { id: "voice", label: "Voice", description: "Calls with voice, camera and screen sharing", icon: "channel-voice", loader: "voice", ownWindow: false },
        { id: "git", label: "Version control", description: "A repository's history, branches and releases", icon: "channel-git", loader: "list" },
        { id: "files", label: "Files", description: "Shared folders and files", icon: "channel-files", loader: "grid" },
        { id: "tasks", label: "Tasks", description: "A board of tasks, or a list of issues", icon: "channel-tasks", loader: "board" },
        { id: "sheets", label: "Sheets", description: "Spreadsheets with formulas, and calendars", icon: "channel-table", loader: "grid" },
        { id: "design", label: "Design", description: "A canvas for layouts, components and prototypes", icon: "channel-design", loader: "canvas" },
        { id: "diagram", label: "Diagram", description: "Flowcharts, UML and database diagrams", icon: "channel-diagram", loader: "canvas" },
        { id: "docs", label: "Docs", description: "A tree of pages to write together", icon: "channel-docs", loader: "pages" },
        { id: "code", label: "Code", description: "Files to edit together, with run and terminals", icon: "channel-code", loader: "list" },
        { id: "browser", label: "Browser", description: "A web page everyone sees together", icon: "channel-browser", loader: "generic", keepAlive: 600 },
      ],
    },
  },
};
