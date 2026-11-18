import { afterEach, describe, expect, it } from "vitest";
import { createWindowLink, type MainCalls, type WindowLink } from "../../src/dm/windows";

const opened: WindowLink[] = [];
const link = (name: string) => {
  const made = createWindowLink(name);
  opened.push(made);
  return made;
};

afterEach(() => {
  opened.splice(0).forEach((l) => l.close());
});

const attachment = { hash: "h", name: "a.png", size: 1, type: "image/png", thumb: null, width: null, height: null };
const refused = () => Promise.reject(new Error("not in this test"));
const calls = (overrides: Partial<MainCalls>): MainCalls => ({
  send: refused, edit: refused, delete: refused, react: refused, retry: refused, download: refused, read: refused,
  forget: refused, closeLink: refused, friend: refused, allowStrangers: refused, ...overrides,
});

describe("the link between the main window and view windows", () => {
  it("answers a view window's call with the main window's result", async () => {
    const main = link("test-calls");
    const view = link("test-calls");
    main.serveViews(calls({ download: async ({ attachment }) => `no ${attachment.name}` }), () => {});
    const answer = await view.askMain("download", { peer: "p", attachment });
    expect(answer).toBe("no a.png");
  });

  it("passes a failure back as an error with its message", async () => {
    const main = link("test-errors");
    const view = link("test-errors");
    main.serveViews(calls({ read: async () => { throw new Error("Not signed in."); } }), () => {});
    await expect(view.askMain("read", { peer: "p" })).rejects.toThrow("Not signed in.");
  });

  it("gives each view window the answer to its own call", async () => {
    const main = link("test-replies");
    const one = link("test-replies");
    const two = link("test-replies");
    main.serveViews(calls({ download: async ({ peer }) => peer }), () => {});
    const answers = await Promise.all([
      one.askMain("download", { peer: "one", attachment }),
      two.askMain("download", { peer: "two", attachment }),
    ]);
    expect(answers).toEqual(["one", "two"]);
  });

  it("tells every view window, and hears what each tells the main window", async () => {
    const main = link("test-tell");
    const view = link("test-tell");
    const toMain = new Promise((resolve) => main.serveViews(calls({}), resolve));
    const toView = new Promise((resolve) => view.followMain((message) => message.kind !== "started" && resolve(message)));
    view.toMain({ kind: "hello", peer: "p" });
    main.toViews({ kind: "blocked", why: null });
    expect(await toMain).toEqual({ kind: "hello", peer: "p" });
    expect(await toView).toEqual({ kind: "blocked", why: null });
  });

  it("tells view windows when a main window starts, and fails what the one before never answered", async () => {
    const view = link("test-restart");
    const heard = new Promise((resolve) => view.followMain(resolve));
    // Asked of a main window that is gone: nothing serves it yet.
    const unanswered = view.askMain("read", { peer: "p" });
    link("test-restart").serveViews(calls({}), () => {});
    expect(await heard).toEqual({ kind: "started" });
    await expect(unanswered).rejects.toThrow("The main window restarted. Try again.");
  });
});
