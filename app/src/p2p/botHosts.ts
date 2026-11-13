// Which device runs which bot, said straight to the other members and never stored. A bot runs on its host
// member's devices only; when that account is open on several devices, each running device repeats its bots every
// few seconds and the one that started a bot first keeps it (core/bots.ts).
import { registerBotHostLink, type BotClaim, type BotHostLink } from "../core/botHosts";
import type { WorkspaceSync } from "./sync";

const repeatMs = 5000;
const expireMs = 15_000;

type Message = { device: string; running: [number, number][] };

export class BotHostChannel implements BotHostLink {
  readonly device = crypto.randomUUID();
  // Announcements from devices that were already running bots have arrived by then.
  readonly readyAt = Date.now() + repeatMs + 1000;
  private readonly send: (message: Message, peer?: string) => void;
  private readonly heard = new Map<string, { running: Map<number, number>; at: number }>();
  private readonly handlers = new Set<() => void>();
  private running = new Map<number, number>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly cleanups: (() => void)[] = [];

  constructor(workspaceId: string, sync: WorkspaceSync) {
    if (sync.mesh) {
      this.send = sync.mesh.channel<Message>("bot-hosts", (message) => {
        if (message.device === this.device || !Array.isArray(message.running)) return;
        const before = this.heard.get(message.device)?.running;
        const running = new Map(message.running);
        this.heard.set(message.device, { running, at: Date.now() });
        // A repeat only keeps the claims alive. Reacting to it made two devices answer each other's unchanged
        // announcements without end, each answer a full reconcile, and pinned the main thread.
        if (!before || !sameRunning(before, running)) this.changed();
      });
      this.cleanups.push(sync.onPeers((peer) => { if (this.running.size) this.send(this.message(), peer); }, () => {}));
    } else {
      this.send = () => {};
    }
    this.timer = setInterval(() => {
      if (this.running.size) this.send(this.message());
      const now = Date.now();
      let expired = false;
      for (const [device, entry] of this.heard)
        if (now - entry.at > expireMs) {
          this.heard.delete(device);
          expired = true;
        }
      if (expired) this.changed();
    }, repeatMs);
    this.cleanups.push(registerBotHostLink(workspaceId, this));
  }

  // Sends only a change: the timer repeats the list and new peers get it when they come.
  announce(running: Map<number, number>): void {
    if (sameRunning(this.running, running)) return;
    this.running = new Map(running);
    this.send(this.message());
  }

  claims(): Map<number, BotClaim[]> {
    const byBot = new Map<number, BotClaim[]>();
    for (const [device, entry] of this.heard)
      for (const [bot, since] of entry.running) byBot.set(bot, [...(byBot.get(bot) ?? []), { device, since }]);
    return byBot;
  }

  onChange(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    clearInterval(this.timer);
    this.cleanups.forEach((cleanup) => cleanup());
  }

  private message(): Message {
    return { device: this.device, running: [...this.running] };
  }

  private changed() {
    this.handlers.forEach((handler) => handler());
  }
}

function sameRunning(a: Map<number, number>, b: Map<number, number>): boolean {
  return a.size === b.size && [...a].every(([bot, since]) => b.get(bot) === since);
}
