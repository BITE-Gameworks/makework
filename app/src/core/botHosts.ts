// The link to the other devices that run bots in a workspace (p2p/botHosts.ts), kept apart from core/bots.ts so the
// p2p side doesn't load the plugin registry.
export interface BotClaim { device: string; since: number }

export interface BotHostLink {
  readonly device: string;
  readonly readyAt: number;
  // This device's running bots: bot id -> when it started them.
  announce(running: Map<number, number>): void;
  // Bots other devices run.
  claims(): Map<number, BotClaim[]>;
  onChange(handler: () => void): () => void;
}

const links = new Map<string, BotHostLink>();
const handlers = new Set<(workspaceId: string) => void>();

export function registerBotHostLink(workspaceId: string, link: BotHostLink): () => void {
  links.set(workspaceId, link);
  handlers.forEach((handler) => handler(workspaceId));
  return () => {
    if (links.get(workspaceId) === link) links.delete(workspaceId);
  };
}

export const botHostLink = (workspaceId: string): BotHostLink | undefined => links.get(workspaceId);

export function onBotHostLink(handler: (workspaceId: string) => void): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
