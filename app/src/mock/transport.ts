import type { Transport } from "../api/transport";
import type { ServerEvent } from "../api/types";
import { MockBackend } from "../system/backend";
import { example } from "./plugins/example";

export function createMockBackend(): MockBackend {
  const backend = new MockBackend();
  backend.load(example);
  return backend;
}

// Talks to an in-memory MockBackend; latency simulates a network round trip.
export class MockTransport implements Transport {
  private readonly unsubscribers = new Set<() => void>();

  constructor(
    readonly backend: MockBackend = createMockBackend(),
    private readonly latencyMs = 0,
  ) {}

  async send(request: string): Promise<string> {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    return this.backend.handle(request);
  }

  subscribe(handler: (event: ServerEvent) => void): () => void {
    const unsubscribe = this.backend.subscribe((event) => queueMicrotask(() => handler(event)));
    this.unsubscribers.add(unsubscribe);
    return () => {
      unsubscribe();
      this.unsubscribers.delete(unsubscribe);
    };
  }

  close(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers.clear();
  }
}
