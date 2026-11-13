import type { ServerEvent } from "./types";

// Carries API requests (JSON) to the plugins' data side and back. MockTransport runs them in this app (system/backend.ts).
export interface Transport {
  send(request: string): Promise<string>;
  subscribe(handler: (event: ServerEvent) => void): () => void;
  close(): void;
}

