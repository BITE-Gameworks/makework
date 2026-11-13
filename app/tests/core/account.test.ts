// Offline accounts and registering them later: the account id (and so every workspace's member id and signed
// history) must not change. IndexedDB and the user server are kept in memory here.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Confirm = { code?: string; totp?: string; device?: string };
const { stores, published, server, offlineChanges } = vi.hoisted(() => ({
  stores: new Map<string, Map<string, unknown>>(),
  published: [] as { id: string; username: string; publicKey: unknown }[],
  offlineChanges: [] as boolean[],
  server: {
    // What the user server answers to PUT /me. Servers from before profiles followed the account send no profile.
    reply: { created: true } as { created: boolean; profile?: { displayName: string; color: string; avatar: string; updatedAt?: number } },
    // What it answers to a password sign-in (POST /login).
    fetchAccount: (async () => { throw new Error("unused"); }) as (login: unknown, password: string, confirm: Confirm) => Promise<unknown>,
  },
}));

vi.mock("../../src/core/db", () => ({
  dbGet: async (store: string, key: string) => stores.get(store)?.get(key),
  dbAll: async (store: string) => [...(stores.get(store)?.values() ?? [])],
  dbPut: async (store: string, value: unknown, key?: string) => {
    const rows = stores.get(store) ?? new Map<string, unknown>();
    stores.set(store, rows);
    rows.set(key ?? (value as Row).id as string, value);
  },
  dbDelete: async (store: string, key: string) => void stores.get(store)?.delete(key),
}));

vi.mock("../../src/core/userServer", () => ({
  userServer: () => "https://me.test",
  setUserServerOffline: (value: boolean) => offlineChanges.push(value),
  publishAccount: async (signer: { id: string }, account: { username: string; publicKey: unknown }) => {
    published.push({ id: signer.id, username: account.username, publicKey: account.publicKey });
    return server.reply;
  },
  UserServerError: class UserServerError extends Error {
    constructor(readonly status: number, message: string, readonly needs: string | null = null) {
      super(message);
    }
  },
  fetchAccount: (login: unknown, password: string, confirm: Confirm) => server.fetchAccount(login, password, confirm),
  // Imported by account.ts but not reached by these tests.
  newLogin: async () => ({ salt: "salt", iterations: 1, auth: "auth" }),
  answerReset: async () => {},
  fetchRecoveryCopy: async () => "",
  startTotp: async () => { throw new Error("unused"); },
  confirmTotp: async () => { throw new Error("unused"); },
  turnOffTotp: async () => { throw new Error("unused"); },
  githubResult: async () => { throw new Error("unused"); },
  githubStartUrl: () => "",
  currentUserServer: () => "",
  ownAccount: async () => ({
    email: null, github: null, hasPassword: true, recoveryCopy: true, recoveryOff: false, recoveryKey: false, keepsCopies: true,
  }),
  requestCode: async () => {},
  requestFromDevice: async () => "",
  resetRequestStatus: async () => ({ status: "waiting", sealed: null }),
  startReset: async () => { throw new Error("unused"); },
}));

import { account, accountSync, createOfflineAccount, registerExisting, setOfflineMode, signInOnline, syncAccount } from "../../src/core/account";
import { createIdentity, lockKey } from "../../src/core/identity";
import { UserServerError } from "../../src/core/userServer";

describe("offline accounts", () => {
  beforeEach(() => {
    stores.clear();
    published.length = 0;
    offlineChanges.length = 0;
    server.reply = { created: true };
  });

  it("works with a local account that is never published", async () => {
    await createOfflineAccount(false);
    const me = account();
    expect(me?.offline).toBe(true);
    expect(me?.publishedTo).toBeNull();
    expect(me?.hasPassword).toBe(false);
    expect(accountSync()).toEqual({ state: "local" });
    expect(published).toEqual([]);
  });

  it("keeps the same id and key when the offline account is registered", async () => {
    await createOfflineAccount(true);
    const before = account()!;
    await registerExisting({
      email: "ada@example.com", code: "123456", username: "ada", displayName: "Ada", password: "correct horse", remember: true,
    });
    const after = account()!;
    expect(after.id).toBe(before.id);
    expect(after.offline).toBe(false);
    expect(after.username).toBe("ada");
    expect(after.email).toBe("ada@example.com");
    expect(after.hasPassword).toBe(true);
    // The first publish is the registration; the account's own sync may publish again.
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((p) => p.id === before.id)).toBe(true);
    expect(published[0]).toMatchObject({ id: before.id, username: "ada", publicKey: before.publicKey });
  });

  it("temporarily disables and restores user-server sync without changing publication", async () => {
    await createOfflineAccount(true);
    await registerExisting({
      email: "ada@example.com", code: "123456", username: "ada", displayName: "Ada", password: "correct horse", remember: true,
    });
    const count = published.length;
    offlineChanges.length = 0;

    await setOfflineMode(true);
    expect(account()?.offline).toBe(false);
    expect(account()?.offlineMode).toBe(true);
    expect(accountSync()).toEqual({ state: "local" });
    expect(published).toHaveLength(count);

    await setOfflineMode(false);
    await syncAccount();
    expect(account()?.offlineMode).toBe(false);
    expect(offlineChanges).toEqual([true, false]);
  });
});

// A password sign-in on a device that doesn't hold the account: the user server hands the key out only with the
// sign-in code it mails, so the first try ends in "email" with nothing kept here.
describe("signing in with an account kept on the user server", () => {
  beforeEach(() => {
    stores.clear();
    published.length = 0;
  });

  it("waits for the emailed sign-in code, then signs in with it", async () => {
    const identity = await createIdentity(true);
    const online = {
      id: identity.id, username: "ada", tag: "0000", publicKey: { x: identity.publicKey.x!, y: identity.publicKey.y! },
      profile: { displayName: "Ada", color: "#335577", avatar: "gen:seed" }, hasPassword: true, createdAt: 1,
      locked: await lockKey(identity.privateKey, "correct horse", 1000),
    };
    const asked: Confirm[] = [];
    server.fetchAccount = async (_login, _password, confirm) => {
      asked.push(confirm);
      if (confirm.code === undefined) throw new UserServerError(403, "We emailed you a code to confirm this sign-in.", "email");
      if (confirm.code !== "123456") throw new UserServerError(400, "That code isn't right.");
      return online;
    };

    expect(await signInOnline("Ada@Example.com", "correct horse", false)).toBe("email");
    expect(stores.get("accounts")?.size ?? 0).toBe(0);
    // A wrong code is the user server's refusal, not another wait.
    await expect(signInOnline("Ada@Example.com", "correct horse", false, { kind: "email", code: "000000" })).rejects.toThrow("That code isn't right.");
    expect(stores.get("accounts")?.size ?? 0).toBe(0);

    expect(await signInOnline("Ada@Example.com", "correct horse", false, { kind: "email", code: "123456" })).toBe("in");
    expect(account()).toMatchObject({ id: identity.id, email: "ada@example.com", displayName: "Ada", hasPassword: true });
    expect(stores.get("accounts")?.has(identity.id)).toBe(true);
    // Each try names this device, for the email.
    expect(asked.map((a) => a.code)).toEqual([undefined, "000000", "123456"]);
    expect(asked.every((a) => typeof a.device === "string" && a.device !== "")).toBe(true);
  });

  it("asks for the authenticator app's code when the account uses one", async () => {
    const identity = await createIdentity(true);
    const online = {
      id: identity.id, username: "ada", tag: "0000", publicKey: { x: identity.publicKey.x!, y: identity.publicKey.y! },
      profile: { displayName: "Ada", color: "#335577", avatar: "gen:seed" }, hasPassword: true, createdAt: 1,
      locked: await lockKey(identity.privateKey, "correct horse", 1000),
    };
    const asked: Confirm[] = [];
    server.fetchAccount = async (_login, _password, confirm) => {
      asked.push(confirm);
      if (confirm.totp === undefined) throw new UserServerError(403, "Enter the code from your authenticator app.", "totp");
      return online;
    };
    expect(await signInOnline("ada@example.com", "correct horse", false)).toBe("totp");
    expect(await signInOnline("ada@example.com", "correct horse", false, { kind: "totp", code: "654321" })).toBe("in");
    expect(asked.map((a) => [a.code, a.totp])).toEqual([[undefined, undefined], [undefined, "654321"]]);
  });

  it("signs in at once where the user server asks for no code (an account without an email, an older server)", async () => {
    const identity = await createIdentity(true);
    server.fetchAccount = async () => ({
      id: identity.id, username: "ada", tag: "0000", publicKey: { x: identity.publicKey.x!, y: identity.publicKey.y! },
      profile: { displayName: "Ada", color: "#335577", avatar: "gen:seed" }, hasPassword: true, createdAt: 1,
      locked: await lockKey(identity.privateKey, "correct horse", 1000),
    });
    expect(await signInOnline("ada", "correct horse", false)).toBe("in");
    expect(account()?.id).toBe(identity.id);
  });
});

// The user server keeps the newest profile across devices and sends it back from PUT /me (user-server/worker.js, since
// profiles follow the account). One deployed before that sends none: reading it failed with "Cannot read properties of
// undefined (reading 'displayName')", shown under Settings > Account > User server.
describe("publishing the account", () => {
  const register = async () => {
    await createOfflineAccount(true);
    await registerExisting({
      email: "ada@example.com", code: "123456", username: "ada", displayName: "Ada", password: "correct horse", remember: true,
    });
    await syncAccount();
  };
  beforeEach(() => {
    stores.clear();
    published.length = 0;
  });

  it("ends the sync ok with a user server that sends no profile back (one from before profiles followed the account)", async () => {
    server.reply = { created: true };
    await register();
    expect(accountSync()).toEqual({ state: "ok" });
    expect(account()?.displayName).toBe("Ada");
  });

  it("takes a newer profile the user server sends back (written on another device)", async () => {
    server.reply = { created: false, profile: { displayName: "Ada Lovelace", color: "#335577", avatar: "gen:seed", updatedAt: Date.now() + 60_000 } };
    await register();
    expect(accountSync()).toEqual({ state: "ok" });
    expect(account()?.displayName).toBe("Ada Lovelace");
  });
});
