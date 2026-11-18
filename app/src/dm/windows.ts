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
  // The main window started serving (again, after a reload): it knows no view window, and calls made of the one
  // before get no answer.
  | { kind: "started" }
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

// After a main window starts, a view window asks which of its waiting calls that window has (`check`); the main
// window answers with the ones it doesn't (`lost`), which never reached it. Its replies to the others come in order,
// before that answer or after it, so nothing is failed that will still be answered.
type Envelope =
  | { to: "main"; message: ToMain }
  | { to: "main"; call: { id: string; action: CallName; args: unknown } }
  | { to: "main"; check: string[] }
  | { to: "views"; message: ToViews }
  | { to: "views"; reply: { id: string; value?: unknown; error?: string } }
  | { to: "views"; lost: string[] };

export interface WindowLink {
  readonly name: string;
  // Main window: runs what view windows ask for and hears what they tell, after telling them it started. Returns its
  // unsubscribe.
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
  const fail = (ids: Iterable<string>, why: string) => {
    for (const id of ids) {
      pending.get(id)?.reject(new Error(why));
      pending.delete(id);
    }
  };
  const stopReplies = listen((envelope) => {
    if (envelope.to !== "views") return;
    if ("message" in envelope) {
      if (envelope.message.kind === "started" && pending.size) post({ to: "main", check: [...pending.keys()] });
      return;
    }
    if ("lost" in envelope) return fail(envelope.lost, "The main window restarted. Try again.");
    const { id, value, error } = envelope.reply;
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    if (error === undefined) waiting.resolve(value);
    else waiting.reject(new Error(error));
  });

  return {
    name,
    serveViews: (calls, onMessage) => {
      // Calls being run; one done has had its reply sent.
      const running = new Set<string>();
      const reply = (id: string, answer: { value?: unknown; error?: string }) => {
        running.delete(id);
        post({ to: "views", reply: { id, ...answer } });
      };
      const stop = listen((envelope) => {
        if (envelope.to !== "main") return;
        if ("message" in envelope) return onMessage(envelope.message);
        if ("check" in envelope) return post({ to: "views", lost: envelope.check.filter((id) => !running.has(id)) });
        const { id, action, args } = envelope.call;
        if (!Object.hasOwn(calls, action)) return post({ to: "views", reply: { id, error: `Unknown action ${action}.` } });
        const run = calls[action] as (args: unknown) => Promise<unknown>;
        running.add(id);
        void Promise.resolve().then(() => run(args)).then(
          (value) => reply(id, { value }),
          (e: unknown) => reply(id, { error: e instanceof Error ? e.message : String(e) }),
        );
      });
      post({ to: "views", message: { kind: "started" } });
      return stop;
    },
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
      fail([...pending.keys()], "The window closed its link to the main window.");
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
