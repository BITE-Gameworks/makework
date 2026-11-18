// The channel between the main window and view windows for private messages and friends (decision 0031). The main
// window runs them (dm/messages.ts, dm/friends.ts); a view window shows their state and asks the main window to act.
// Windows of the app share storage (the conversation list, stored messages, content), so only what lives in a
// window's memory goes over this channel. Everything sent is structured-cloned: plain objects, never store proxies.
import type { Upload } from "../core/files";
import type { SharedPresenceStatus } from "../core/presence";
import type { RelationChange, Relations } from "../core/userServer";
import type { Attachment, Conversation, DmMessage } from "./messages";

// A stored message, as the main window looks it up again.
export interface MessageRef {
  peer: string;
  id: string;
  at: number;
}

// What a view window can ask the main window to do. Each resolves once the main window has done it.
export interface MainCalls {
  send(args: { peer: string; text: string; uploads: Upload[] }): Promise<void>;
  edit(args: { ref: MessageRef; text: string }): Promise<void>;
  delete(args: { ref: MessageRef }): Promise<void>;
  react(args: { ref: MessageRef; code: string }): Promise<void>;
  retry(args: { ref: MessageRef }): Promise<void>;
  // Resolves with why it failed, or "".
  download(args: { peer: string; attachment: Attachment }): Promise<string>;
  read(args: { peer: string }): Promise<void>;
  forget(args: { peer: string }): Promise<void>;
  closeLink(args: { peer: string }): Promise<void>;
  friend(args: { action: RelationChange; id: string }): Promise<void>;
  allowStrangers(args: { allow: boolean }): Promise<void>;
}

export type CallName = keyof MainCalls;
type Args<A extends CallName> = Parameters<MainCalls[A]>[0];
type Result<A extends CallName> = Awaited<ReturnType<MainCalls[A]>>;

// What the main window tells view windows.
export type ToViews =
  | { kind: "list"; conversations: Conversation[] }
  // A message as it was just stored (new, changed status, edited, deleted or reacted to).
  | { kind: "message"; message: DmMessage }
  | { kind: "forgotten"; peer: string }
  | { kind: "link"; peer: string; online: boolean; shown: SharedPresenceStatus | null }
  | { kind: "blocked"; why: string | null }
  | { kind: "relations"; relations: Relations | null }
  | { kind: "progress"; hash: string; value: number | undefined }
  | { kind: "downloaded"; hash: string };

// What a view window tells the main window.
export type ToMain =
  // A view window opened: the main window answers with what it needs (the list, and the peer's link if it has one).
  | { kind: "hello"; peer?: string }
  // Which conversation a view window shows and whether it has the focus; peer null once it closes.
  | { kind: "looking"; window: string; peer: string | null; focused: boolean };

type Envelope =
  | { to: "main"; message: ToMain }
  | { to: "main"; call: { id: string; action: CallName; args: unknown } }
  | { to: "views"; message: ToViews }
  | { to: "views"; reply: { id: string; value?: unknown; error?: string } };

export interface WindowLink {
  readonly name: string;
  // Main window: runs what view windows ask for and hears what they tell. Returns its unsubscribe.
  serveViews(calls: MainCalls, onMessage: (message: ToMain) => void): () => void;
  toViews(message: ToViews): void;
  // View window: hears what the main window tells. Returns its unsubscribe.
  followMain(onMessage: (message: ToViews) => void): () => void;
  toMain(message: ToMain): void;
  askMain<A extends CallName>(action: A, args: Args<A>): Promise<Result<A>>;
  close(): void;
}

export function createWindowLink(name: string): WindowLink {
  const channel = new BroadcastChannel(name);
  // Replies reach every view window: an id made unique per window picks out the one that asked.
  const idPrefix = Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join("");
  let nextId = 0;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const post = (envelope: Envelope) => channel.postMessage(envelope);
  const listen = (handler: (envelope: Envelope) => void) => {
    const onMessage = (e: MessageEvent<Envelope>) => handler(e.data);
    channel.addEventListener("message", onMessage);
    return () => channel.removeEventListener("message", onMessage);
  };
  const stopReplies = listen((envelope) => {
    if (envelope.to !== "views" || !("reply" in envelope)) return;
    const { id, value, error } = envelope.reply;
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    if (error === undefined) waiting.resolve(value);
    else waiting.reject(new Error(error));
  });

  return {
    name,
    serveViews: (calls, onMessage) => listen((envelope) => {
      if (envelope.to !== "main") return;
      if ("message" in envelope) return onMessage(envelope.message);
      const { id, action, args } = envelope.call;
      if (!Object.hasOwn(calls, action)) return post({ to: "views", reply: { id, error: `Unknown action ${action}.` } });
      const run = calls[action] as (args: unknown) => Promise<unknown>;
      void Promise.resolve().then(() => run(args)).then(
        (value) => post({ to: "views", reply: { id, value } }),
        (e: unknown) => post({ to: "views", reply: { id, error: e instanceof Error ? e.message : String(e) } }),
      );
    }),
    toViews: (message) => post({ to: "views", message }),
    followMain: (onMessage) => listen((envelope) => {
      if (envelope.to === "views" && "message" in envelope) onMessage(envelope.message);
    }),
    toMain: (message) => post({ to: "main", message }),
    askMain: <A extends CallName>(action: A, args: Args<A>) => new Promise<Result<A>>((resolve, reject) => {
      const id = `${idPrefix}-${nextId++}`;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      post({ to: "main", call: { id, action, args } });
    }),
    close: () => {
      stopReplies();
      channel.close();
      for (const waiting of pending.values()) waiting.reject(new Error("The window closed its link to the main window."));
      pending.clear();
    },
  };
}

let shared: WindowLink | null = null;

// This window's link for the signed-in account, opened again when the account changes.
export function windowLinkFor(accountId: string): WindowLink {
  const name = `makework-dm:${accountId}`;
  if (shared?.name !== name) {
    shared?.close();
    shared = createWindowLink(name);
  }
  return shared;
}

// A view window's action on private messages or friends, done by the main window.
export function askMain<A extends CallName>(action: A, args: Args<A>): Promise<Result<A>> {
  if (!shared) return Promise.reject(new Error("This window isn't connected to the main window."));
  return shared.askMain(action, args);
}
