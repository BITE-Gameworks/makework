// A bot's username is its type id: "helpbot" and "agent" stay as they are. Workspaces from before stored "bot" added
// to types that lacked it ("replybot", even "helpbotbot"), and keep what they stored.
export function botUsername(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export const cleanBotUsername = (username: string): string => username.replace(/botbot$/, "bot");
