// The user server worker (../user-server) run in process on node:sqlite, driven through core/userServer.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountTag, base64url, createIdentity, exportPkcs8, fromBase64url, importPrivateKey, lockKey, unlockPkcs8 } from "../../src/core/identity";
import {
  lockWithRecoveryKey, newRecoveryKey, openFromDevice, requestKeyPair, sealForDevice, unlockWithRecoveryKey,
} from "../../src/core/recovery";
import {
  sendFeedback, userServerVersion, answerReset, authHeader, changeRelation, githubResult, githubStartUrl, serverFeatures, changeSettings, confirmMessages, deleteUserServerAccount, reportAccount, fetchAccount, fetchRecoveryCopy, fetchRelations, findAccount, leaveMessage,
  newLogin, ownAccount, pendingResets, publishAccount, readVault, requestCode, requestFromDevice, resetRequestStatus, setUserServer, setUserServerOffline,
  startReset, waitingMessages, writeVault, startTotp, confirmTotp, turnOffTotp, type Signer,
} from "../../src/core/userServer";
// @ts-expect-error plain JS worker without types
import worker from "../../../user-server/worker.js";
import { userDatabase } from "../d1";

async function account(username: string, password = "correct horse") {
  const identity = await createIdentity(true);
  const pkcs8 = await exportPkcs8(identity.privateKey);
  const signer: Signer = { id: identity.id, key: await importPrivateKey(pkcs8, false) };
  const publicKey = { x: identity.publicKey.x!, y: identity.publicKey.y! };
  const locked = await lockKey(identity.privateKey, password, 1000);
  const login = { ...(await newLogin(password)), locked };
  const profile = { displayName: username, color: "#fff", avatar: "gen:seed" };
  return { identity, pkcs8, signer, publicKey, locked, login, profile, username };
}

// The authenticator app's code for `secret` (base32) at `at`, as RFC 6238 computes it.
async function totpCode(secret: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const raw = new Uint8Array(Math.floor(bits.length / 8)).map((_, i) => Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new DataView(new ArrayBuffer(8));
  counter.setUint32(4, Math.floor(at / 30_000));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
  const o = mac[19] & 0xf;
  return String((((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3]) % 1_000_000).padStart(6, "0");
}

let mails: { to: string; subject: string; text: string; replyTo?: string }[] = [];
let requestCount = 0;
// The code in the last email to that address.
const codeFor = (email: string) => mails.filter((m) => m.to === email).at(-1)?.subject.match(/\d{6}/)?.[0] ?? "";

beforeEach(() => {
  mails = [];
  requestCount = 0;
  setUserServerOffline(false);
  const env = {
    DB: userDatabase(), NAME: "Test accounts", RECOVERY_SECRET: "test secret", RESEND_API_KEY: "re_test", FEEDBACK_TO: "feedback@test",
    GITHUB_CLIENT_ID: "gh-client", GITHUB_CLIENT_SECRET: "gh-secret", APP_ORIGINS: "http://localhost:1420",
  };
  // The app's requests go to the worker; the worker's own requests to Resend are caught here.
  vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => {
    requestCount++;
    if (String(url).startsWith("https://api.resend.com/")) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer re_test");
      const mail = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; reply_to?: string };
      mails.push({ to: mail.to[0], subject: mail.subject, text: mail.text, replyTo: mail.reply_to });
      return Response.json({ id: "email-1" });
    }
    // GitHub: code "ok-<id>" signs in GitHub user <id>.
    if (String(url) === "https://github.com/login/oauth/access_token") {
      const { code, client_secret } = JSON.parse(String(init?.body));
      return Response.json(client_secret === "gh-secret" && code.startsWith("ok-") ? { access_token: `token-${code.slice(3)}` } : { error: "bad_verification_code" });
    }
    if (String(url) === "https://api.github.com/user") {
      const id = new Headers(init?.headers).get("Authorization")?.replace("Bearer token-", "");
      return id ? Response.json({ id: Number(id), login: `octo${id}`, name: `Octo ${id}` }) : new Response("", { status: 401 });
    }
    return worker.fetch(new Request(url, init), env);
  });
  setUserServer("https://me.test");
});

describe("user server", () => {
  it("makes no requests while temporary offline mode is on", async () => {
    setUserServerOffline(true);
    await expect(serverFeatures()).rejects.toMatchObject({ status: 0, message: "Offline mode is on." });
    expect(requestCount).toBe(0);
    setUserServerOffline(false);
  });

  it("publishes an account, finds it and signs in with the password", async () => {
    const a = await account("ada");
    expect(await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, login: a.login }))
      .toMatchObject({ created: true });
    const tag = accountTag(a.identity.id);
    expect(await findAccount({ name: `ada·${tag}` })).toMatchObject({ id: a.identity.id, hasPassword: true, tag });
    expect(await findAccount({ id: a.identity.id })).toMatchObject({ username: "ada" });
    expect(await findAccount({ name: "nobody·0000" })).toBeNull();

    // Accounts from before emails still sign in by username, with no sign-in code: there is nowhere to send one.
    const online = await fetchAccount({ username: "Ada" }, "correct horse");
    expect(online.id).toBe(a.identity.id);
    expect(await unlockPkcs8(online.locked, "correct horse")).not.toBeNull();
    await expect(fetchAccount({ username: "ada" }, "wrong")).rejects.toMatchObject({ status: 401 });
    expect(mails).toEqual([]);
  }, 30_000);

  it("keeps the newest profile across devices", async () => {
    const a = await account("ada");
    const newer = { displayName: "Ada L.", color: "#222", avatar: "gen:two", updatedAt: 2000 };
    const older = { displayName: "Ada", color: "#111", avatar: "gen:one", updatedAt: 1000 };
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: newer });
    // An older profile from another device doesn't replace it.
    const late = await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: older });
    expect(late.profile).toEqual(newer);
    expect((await findAccount({ id: a.identity.id }))!.profile).toEqual(newer);
    // A newer one does.
    const newest = { displayName: "Ada", color: "#333", avatar: "gen:three", updatedAt: 3000 };
    expect((await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: newest })).profile).toEqual(newest);
  }, 30_000);

  it("lets people share usernames and keeps keys fixed", async () => {
    const a = await account("ada");
    const b = await account("ada");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile });
    await publishAccount(b.signer, { username: "ada", publicKey: b.publicKey, profile: b.profile });
    expect((await findAccount({ name: `ada#${accountTag(b.identity.id)}` }))?.id).toBe(b.identity.id);
    // Someone else's key under ada's id.
    await expect(publishAccount(a.signer, { username: "ada", publicKey: b.publicKey, profile: a.profile }))
      .rejects.toMatchObject({ status: 400 });
  }, 30_000);

  it("confirms an email with a code and signs in with it", async () => {
    const a = await account("ada");
    await requestCode("Ada@Example.com", "register");
    const code = codeFor("ada@example.com");
    expect(code).toMatch(/^\d{6}$/);
    const publish = (extra: object) => publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, login: a.login, ...extra });
    await expect(publish({ email: "ada@example.com", code: "000000" === code ? "111111" : "000000" })).rejects.toMatchObject({ status: 400 });
    await publish({ email: "ada@example.com", code });
    // A code works once.
    const b = await account("bob");
    await expect(publishAccount(b.signer, { username: "bob", publicKey: b.publicKey, profile: b.profile, email: "ada@example.com", code }))
      .rejects.toMatchObject({ status: 400 });

    expect((await signInWithCode("ADA@example.com", "correct horse")).id).toBe(a.identity.id);
    expect(await findAccount({ email: "ada@example.com", signer: a.signer })).toMatchObject({ id: a.identity.id });
    expect(await ownAccount(a.signer)).toMatchObject({ email: "ada@example.com", recoveryCopy: false, keepsCopies: true });
    // Signing up again with a used email only tells its owner.
    await requestCode("ada@example.com", "register");
    expect(mails.at(-1)!.text).toMatch(/already has a MakeWork account/);
    // Reset codes go only to emails with an account, but the answer is the same.
    await requestCode("nobody@example.com", "reset");
    expect(mails.filter((m) => m.to === "nobody@example.com")).toEqual([]);
  }, 30_000);

  async function withEmail(name: string, email: string, extra: object = {}) {
    const a = await account(name);
    await requestCode(email, "register");
    await publishAccount(a.signer, { username: name, publicKey: a.publicKey, profile: a.profile, login: a.login, email, code: codeFor(email), ...extra });
    return a;
  }
  async function reset(email: string) {
    await requestCode(email, "reset");
    return startReset(email, codeFor(email));
  }
  // A password sign-in by email as the app does it: the first try makes the user server mail a sign-in code, the
  // second brings it back.
  async function signInWithCode(email: string, password: string) {
    await expect(fetchAccount({ email }, password)).rejects.toMatchObject({ status: 403, needs: "email" });
    return fetchAccount({ email }, password, { code: codeFor(email.toLowerCase()) });
  }

  it("hands the key to a password sign-in only with the code mailed to the account", async () => {
    const a = await withEmail("ada", "ada@example.com");
    mails = [];
    // A wrong password gets no mail, so only someone who has the password can make the server send one.
    await expect(fetchAccount({ email: "ada@example.com" }, "wrong")).rejects.toMatchObject({ status: 401, needs: null });
    expect(mails).toEqual([]);
    // The right password alone gets a code by mail instead of the key. Apps from before sign-in codes show the message.
    await expect(fetchAccount({ email: "ada@example.com" }, "correct horse", { device: "Windows · Chrome" }))
      .rejects.toMatchObject({ status: 403, needs: "email", message: expect.stringContaining("Update MakeWork") });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("ada@example.com");
    expect(mails[0].subject).toMatch(/sign-in code: \d{6}$/);
    expect(mails[0].text).toContain("on Windows · Chrome:");
    const code = codeFor("ada@example.com");
    await expect(fetchAccount({ email: "ada@example.com" }, "correct horse", { code: code === "000000" ? "111111" : "000000" }))
      .rejects.toMatchObject({ status: 400, needs: null });
    // The code is no use without the password.
    await expect(fetchAccount({ email: "ada@example.com" }, "wrong", { code })).rejects.toMatchObject({ status: 401 });
    const online = await fetchAccount({ email: "ada@example.com" }, "correct horse", { code });
    expect(online.id).toBe(a.identity.id);
    expect(await unlockPkcs8(online.locked, "correct horse")).not.toBeNull();
    // A code works once, and none of this sent another mail.
    await expect(fetchAccount({ email: "ada@example.com" }, "correct horse", { code })).rejects.toMatchObject({ status: 400 });
    expect(mails).toHaveLength(1);
  }, 30_000);

  it("takes an authenticator app's code in place of the emailed one once it is on", async () => {
    const a = await withEmail("ada", "ada@example.com");
    const { secret, uri } = await startTotp(a.signer);
    expect(uri).toContain(`secret=${secret}`);
    // Not on until a code from the app confirms it.
    await expect(fetchAccount({ email: "ada@example.com" }, "correct horse")).rejects.toMatchObject({ needs: "email" });
    await expect(confirmTotp(a.signer, "000000" === await totpCode(secret) ? "111111" : "000000")).rejects.toMatchObject({ status: 400 });
    const backup = await confirmTotp(a.signer, await totpCode(secret));
    expect(backup).toHaveLength(10);
    expect(await ownAccount(a.signer)).toMatchObject({ totp: true, backupCodes: 10 });

    // The password alone now asks for the app's code and mails nothing.
    mails = [];
    await expect(fetchAccount({ email: "ada@example.com" }, "correct horse")).rejects.toMatchObject({ status: 403, needs: "totp" });
    expect(mails).toEqual([]);
    await expect(fetchAccount({ email: "ada@example.com" }, "wrong", { totp: await totpCode(secret, Date.now() + 30_000) })).rejects.toMatchObject({ status: 401 });
    // The next step's code (a clock a little ahead) signs in once; the current one is then too old.
    const ahead = await totpCode(secret, Date.now() + 30_000);
    expect((await fetchAccount({ email: "ada@example.com" }, "correct horse", { totp: ahead })).id).toBe(a.identity.id);
    await expect(fetchAccount({ email: "ada@example.com" }, "correct horse", { totp: ahead })).rejects.toMatchObject({ status: 400 });

    // A backup code works once, written any way.
    expect((await fetchAccount({ email: "ada@example.com" }, "correct horse", { totp: backup[0].toUpperCase().replace("-", " ") })).id).toBe(a.identity.id);
    await expect(fetchAccount({ email: "ada@example.com" }, "correct horse", { totp: backup[0] })).rejects.toMatchObject({ status: 400 });
    expect(await ownAccount(a.signer)).toMatchObject({ backupCodes: 9 });

    // Turning it off takes a code too; then the email code is back.
    await expect(turnOffTotp(a.signer, "nonsense")).rejects.toMatchObject({ status: 400 });
    await turnOffTotp(a.signer, backup[1]);
    expect(await ownAccount(a.signer)).toMatchObject({ totp: false, backupCodes: 0 });
    await expect(fetchAccount({ email: "ada@example.com" }, "correct horse")).rejects.toMatchObject({ needs: "email" });
  }, 30_000);

  it("asks the authenticator app's code for the recovery copy too", async () => {
    const a = await withEmail("ada", "ada@example.com", {});
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, recoveryCopy: base64url(a.pkcs8) });
    const { secret } = await startTotp(a.signer);
    const backup = await confirmTotp(a.signer, await totpCode(secret));
    const started = await reset("ada@example.com");
    expect(started).toMatchObject({ recoveryCopy: true, totp: true });
    await expect(fetchRecoveryCopy(started.token)).rejects.toMatchObject({ status: 403, needs: "totp" });
    expect(fromBase64url(await fetchRecoveryCopy(started.token, backup[0]))).toEqual(a.pkcs8);
  }, 30_000);

  it("keeps sign-in codes apart from other codes and limits them", async () => {
    const a = await withEmail("ada", "ada@example.com");
    // The app's request without deriving the login key from the password each time.
    const signIn = (extra: object = {}) => fetch("https://me.test/login", {
      method: "POST", body: JSON.stringify({ email: "ada@example.com", auth: a.login.auth, ...extra }),
    });
    const answer = async (response: Promise<Response>) => {
      const r = await response;
      return { status: r.status, ...(await r.json() as { error?: string; needsCode?: boolean; account?: { id: string } }) };
    };
    // What a device writes about itself goes into the mail only as a plain label.
    expect(await answer(signIn({ device: "Chrome\nYour code is 999999" }))).toMatchObject({ status: 403, needsCode: true });
    expect(mails.at(-1)!.text).not.toContain("999999");
    expect(mails.at(-1)!.text).toContain("signing in to MakeWork: ");

    // A sign-in code doesn't start a password reset.
    const first = codeFor("ada@example.com");
    await expect(startReset("ada@example.com", first)).rejects.toMatchObject({ status: 400 });
    expect(await answer(signIn({ code: first }))).toMatchObject({ status: 200, account: { id: a.identity.id } });
    // And a reset code doesn't sign in: the sign-in code above is used up, the reset code is the only live one.
    await requestCode("ada@example.com", "reset");
    expect(await answer(signIn({ code: codeFor("ada@example.com") }))).toMatchObject({ status: 400 });

    // Five wrong guesses use a code up, even for the right one.
    expect(await answer(signIn())).toMatchObject({ status: 403, needsCode: true });
    const second = codeFor("ada@example.com");
    const wrong = second === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await signIn({ code: wrong })).status).toBe(400);
    expect(await answer(signIn({ code: second }))).toMatchObject({ status: 429, error: expect.stringContaining("Ask for a new one") });

    // Five codes an hour for an email: two were sent above.
    for (let i = 0; i < 3; i++) expect((await signIn()).status).toBe(403);
    const sent = mails.length;
    expect(await answer(signIn())).toMatchObject({ status: 429, error: expect.stringContaining("Too many codes") });
    expect(mails).toHaveLength(sent);
    // The last code that was sent still signs in.
    expect(await answer(signIn({ code: codeFor("ada@example.com") }))).toMatchObject({ status: 200, account: { id: a.identity.id } });
  }, 30_000);

  it("resets a password from the server's recovery copy", async () => {
    const a = await withEmail("ada", "ada@example.com", {});
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, recoveryCopy: base64url(a.pkcs8) });
    const started = await reset("ada@example.com");
    expect(started).toMatchObject({ recoveryCopy: true, recoveryLocked: null, account: { id: a.identity.id } });
    expect(fromBase64url(await fetchRecoveryCopy(started.token))).toEqual(a.pkcs8);
    expect(mails.at(-1)!.subject).toMatch(/account was restored/);

    // Turned off, it is gone.
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, recoveryCopy: null });
    const again = await reset("ada@example.com");
    expect(again.recoveryCopy).toBe(false);
    await expect(fetchRecoveryCopy(again.token)).rejects.toMatchObject({ status: 404 });
    await expect(fetchRecoveryCopy("made-up-token")).rejects.toMatchObject({ status: 401 });
  }, 30_000);

  it("resets with the recovery key, which the server can't open", async () => {
    const a = await withEmail("ada", "ada@example.com");
    const recoveryKey = newRecoveryKey();
    const recoveryLocked = await lockWithRecoveryKey(a.pkcs8, recoveryKey);
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, recoveryLocked });
    const started = await reset("ada@example.com");
    expect(await unlockWithRecoveryKey(started.recoveryLocked!, recoveryKey.toLowerCase().replaceAll("-", " "))).toEqual(a.pkcs8);
    expect(await unlockWithRecoveryKey(started.recoveryLocked!, newRecoveryKey())).toBeNull();
  }, 30_000);

  it("hands the key over from a device that is still signed in", async () => {
    const a = await withEmail("ada", "ada@example.com");
    const started = await reset("ada@example.com");
    const pair = await requestKeyPair();
    const id = await requestFromDevice(started.token, pair.publicKey, "Windows · Chrome");
    expect(await resetRequestStatus(started.token, id)).toEqual({ status: "waiting", sealed: null });
    const [waiting] = await pendingResets(a.signer);
    expect(waiting.id).toBe(id);
    expect(waiting.device).toBe("Windows · Chrome");
    await answerReset(a.signer, id, await sealForDevice(a.pkcs8, waiting.publicKey));
    const { status, sealed } = await resetRequestStatus(started.token, id);
    expect(status).toBe("approved");
    expect(await openFromDevice(sealed!, pair.privateKey)).toEqual(a.pkcs8);
    expect(await pendingResets(a.signer)).toEqual([]);
  }, 30_000);

  it("moves the email to a fresh account when the key can't come back", async () => {
    const old = await withEmail("ada", "ada@example.com");
    const started = await reset("ada@example.com");
    const fresh = await account("ada", "new password");
    await publishAccount(fresh.signer, {
      username: "ada", publicKey: fresh.publicKey, profile: fresh.profile, login: fresh.login, email: "ada@example.com", resetToken: started.token,
    });
    expect((await signInWithCode("ada@example.com", "new password")).id).toBe(fresh.identity.id);
    expect(await ownAccount(old.signer)).toMatchObject({ email: null, hasPassword: false });
    // The token is used up.
    const other = await account("eve");
    await expect(publishAccount(other.signer, {
      username: "eve", publicKey: other.publicKey, profile: other.profile, email: "ada@example.com", resetToken: started.token,
    })).rejects.toMatchObject({ status: 401 });
  }, 30_000);

  it("keeps messages only until the recipient confirms them", async () => {
    const a = await account("ada");
    const b = await account("bob");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile });
    await publishAccount(b.signer, { username: "bob", publicKey: b.publicKey, profile: b.profile });
    await changeSettings(b.signer, { allowStrangers: true });

    await leaveMessage(a.signer, { id: "message-0001", to: b.identity.id, body: "sealed" });
    await leaveMessage(a.signer, { id: "message-0001", to: b.identity.id, body: "sealed" });
    expect((await waitingMessages(a.signer)).messages).toEqual([]);
    expect((await waitingMessages(b.signer)).messages).toMatchObject([{ id: "message-0001", from: a.identity.id, body: "sealed" }]);
    // Only the recipient can confirm.
    await confirmMessages(a.signer, ["message-0001"]);
    expect((await waitingMessages(b.signer)).messages).toHaveLength(1);
    await confirmMessages(b.signer, ["message-0001"]);
    expect((await waitingMessages(b.signer)).messages).toEqual([]);

    await expect(leaveMessage(a.signer, { id: "message-0002", to: "nobody-here", body: "x" })).rejects.toMatchObject({ status: 404 });
    const stranger = await account("eve");
    await expect(waitingMessages(stranger.signer)).rejects.toMatchObject({ status: 401 });
  }, 30_000);

  it("takes messages from friends only, unless strangers are allowed, and never from blocked people", async () => {
    const a = await account("ada");
    const b = await account("bob");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile });
    await publishAccount(b.signer, { username: "bob", publicKey: b.publicKey, profile: b.profile });
    const leave = (id: string) => leaveMessage(a.signer, { id, to: b.identity.id, body: "x" });

    await expect(leave("message-0001")).rejects.toMatchObject({ status: 403 });
    const asked = await changeRelation(a.signer, "request", b.identity.id);
    expect(asked.outgoing.map((p) => p.username)).toEqual(["bob"]);
    expect((await waitingMessages(b.signer)).relations.incoming.map((p) => p.username)).toEqual(["ada"]);
    const accepted = await changeRelation(b.signer, "accept", a.identity.id);
    expect(accepted.friends.map((p) => p.username)).toEqual(["ada"]);
    expect(accepted.incoming).toEqual([]);
    await leave("message-0002");

    // Blocking ends the friendship, drops what they left and refuses more, even with strangers allowed.
    const blocked = await changeRelation(b.signer, "block", a.identity.id);
    expect(blocked.friends).toEqual([]);
    expect(blocked.blocked.map((p) => p.username)).toEqual(["ada"]);
    expect((await waitingMessages(b.signer)).messages).toEqual([]);
    await changeSettings(b.signer, { allowStrangers: true });
    await expect(leave("message-0003")).rejects.toMatchObject({ status: 403 });
    // Their request is swallowed without telling them.
    await changeRelation(a.signer, "request", b.identity.id);
    expect((await fetchRelations(b.signer)).incoming).toEqual([]);
    await changeRelation(b.signer, "unblock", a.identity.id);
    await leave("message-0004");
  }, 30_000);

  it("mails a report about an account with who sent it, only from signed-in accounts", async () => {
    const a = await account("ada");
    const b = await account("bob");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile });
    await publishAccount(b.signer, { username: "bob", publicKey: b.publicKey, profile: b.profile });
    await reportAccount(a.signer, b.identity.id, "Threats in a call");
    const mail = mails.at(-1)!;
    expect(mail.to).toBe("feedback@test");
    expect(mail.subject).toContain("bob");
    expect(mail.text).toContain(b.identity.id);
    expect(mail.text).toContain(a.identity.id);
    expect(mail.text).toContain("Threats in a call");
    await expect(reportAccount(a.signer, a.identity.id, "x")).rejects.toMatchObject({ status: 400 });
    await expect(reportAccount(a.signer, b.identity.id, " ")).rejects.toMatchObject({ status: 400 });
    const stranger = await account("eve");
    await expect(reportAccount(stranger.signer, b.identity.id, "x")).rejects.toMatchObject({ status: 401 });
  }, 30_000);

  it("deletes an account with everything kept for it, and refuses to publish it again", async () => {
    const a = await account("ada");
    const b = await account("bob");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile });
    await publishAccount(b.signer, { username: "bob", publicKey: b.publicKey, profile: b.profile });
    await changeRelation(a.signer, "request", b.identity.id);
    await changeRelation(b.signer, "accept", a.identity.id);
    await leaveMessage(a.signer, { id: "message-0001", to: b.identity.id, body: "sealed" });
    await writeVault(a.signer, "servers", "sealed", 0);

    await deleteUserServerAccount(a.signer);
    expect(await findAccount({ id: a.identity.id })).toBeNull();
    const left = await waitingMessages(b.signer);
    expect(left.messages).toEqual([]);
    expect(left.relations.friends).toEqual([]);
    await expect(readVault(a.signer, "servers")).rejects.toMatchObject({ status: 401 });
    await expect(publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile })).rejects.toMatchObject({ status: 410 });
  }, 30_000);

  it("keeps vaults per account and refuses writes over a stale revision", async () => {
    const a = await account("ada");
    const b = await account("bob");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile });
    await publishAccount(b.signer, { username: "bob", publicKey: b.publicKey, profile: b.profile });

    expect(await readVault(a.signer, "servers")).toEqual({ data: null, rev: 0 });
    expect(await writeVault(a.signer, "servers", "one", 0)).toEqual({ rev: 1 });
    await expect(writeVault(a.signer, "servers", "other computer", 0)).rejects.toMatchObject({ status: 409 });
    expect(await writeVault(a.signer, "servers", "two", 1)).toEqual({ rev: 2 });
    await expect(writeVault(a.signer, "servers", "stale", 1)).rejects.toMatchObject({ status: 409 });
    expect(await readVault(a.signer, "servers")).toEqual({ data: "two", rev: 2 });
    expect(await readVault(b.signer, "servers")).toEqual({ data: null, rev: 0 });
  }, 30_000);

  // GitHub sends the browser back to the callback; the user server sends it on to where the sign-in started, with
  // the one-time code. Returns that place.
  async function finishOnGitHub(start: Response, id: number) {
    const state = new URL(start.headers.get("Location")!).searchParams.get("state");
    const back = await fetch(`https://me.test/github/callback?code=ok-${id}&state=${state}`);
    expect(back.status).toBe(302);
    return new URL(back.headers.get("Location")!);
  }

  // What the app sees after the person signed in on GitHub as user `id`, from the web build at localhost:1420.
  async function signInOnGitHub(id: number) {
    const session = "session-0123456789abcdefghij";
    const start = await fetch(githubStartUrl(session, "http://localhost:1420"));
    await expect(githubResult(session, "not-the-code-0123456789")).rejects.toMatchObject({ status: 404 });
    const back = await finishOnGitHub(start, id);
    expect(`${back.origin}${back.pathname}`).toBe("http://localhost:1420/github-callback.html");
    const once = new URLSearchParams(back.hash.slice(1)).get("once")!;
    await expect(githubResult(session, "not-the-code-0123456789")).rejects.toMatchObject({ status: 404 });
    return githubResult(session, once);
  }

  it("gives a GitHub sign-in's answer only to the device it went back to", async () => {
    // Someone starts a sign-in, sends the victim the link, and polls with the session id they chose.
    const session = "attacker-0123456789abcdefghij";
    const start = await fetch(`https://me.test/github/start?session=${session}&port=50123`);
    const back = await finishOnGitHub(start, 42);
    // The answer's code went to the victim's own loopback port, never to the one who started it.
    expect(`${back.origin}${back.pathname}`).toBe("http://127.0.0.1:50123/github");
    expect(back.searchParams.get("once")).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    await expect(githubResult(session, "guessed-0123456789abcdefgh")).rejects.toMatchObject({ status: 404 });
    // The code works once, with the session.
    expect((await githubResult(session, back.searchParams.get("once")!)).status).toBe("done");
    await expect(githubResult(session, back.searchParams.get("once")!)).rejects.toMatchObject({ status: 404 });

    // The answer never goes to an origin the server doesn't know the web app at, nor without a place at all.
    expect((await fetch(githubStartUrl(session, "https://evil.example"))).status).toBe(400);
    expect((await fetch(`https://me.test/github/start?session=${session}`)).status).toBe(400);
    expect((await fetch(`https://me.test/github/start?session=${session}&port=80`)).status).toBe(400);
  }, 30_000);

  it("counts wrong emailed codes sent all at once", async () => {
    await withEmail("ada", "ada@example.com");
    await requestCode("ada@example.com", "reset");
    const right = codeFor("ada@example.com");
    const wrong = right === "000000" ? "111111" : "000000";
    const guesses = await Promise.allSettled(Array.from({ length: 20 }, () => startReset("ada@example.com", wrong)));
    const statuses = guesses.map((g) => (g.status === "rejected" ? (g.reason as { status: number }).status : 200));
    // Only five were compared with the code; the rest, and the right code after them, are refused unchecked.
    expect(statuses.filter((s) => s === 400)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    await expect(startReset("ada@example.com", right)).rejects.toMatchObject({ status: 429 });
  }, 30_000);

  it("hands the recovery copy out once per reset", async () => {
    const a = await withEmail("ada", "ada@example.com");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, recoveryCopy: base64url(a.pkcs8) });
    const started = await reset("ada@example.com");
    // Asking a device still works with the token before the copy is taken.
    const id = await requestFromDevice(started.token, (await requestKeyPair()).publicKey, "Linux");
    expect(await resetRequestStatus(started.token, id)).toMatchObject({ status: "waiting" });
    expect(fromBase64url(await fetchRecoveryCopy(started.token))).toEqual(a.pkcs8);
    await expect(fetchRecoveryCopy(started.token)).rejects.toMatchObject({ status: 401 });
    // The reset itself goes on: a fresh account can still take the email over with the same token.
    const fresh = await account("ada2");
    await publishAccount(fresh.signer, { username: "ada2", publicKey: fresh.publicKey, profile: fresh.profile, email: "ada@example.com", resetToken: started.token });
    expect(await findAccount({ email: "ada@example.com", signer: a.signer })).toMatchObject({ id: fresh.identity.id });
  }, 30_000);

  it("hands the recovery copy out even when the notice email can't be sent", async () => {
    const a = await withEmail("ada", "ada@example.com");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, recoveryCopy: base64url(a.pkcs8) });
    const started = await reset("ada@example.com");
    const sent = vi.mocked(fetch);
    vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) =>
      String(url).startsWith("https://api.resend.com/") ? new Response("down", { status: 503 }) : sent(url, init));
    expect(fromBase64url(await fetchRecoveryCopy(started.token))).toEqual(a.pkcs8);
  }, 30_000);

  it("counts guesses sent at the same moment", async () => {
    const a = await account("ada");
    const email = "ada@example.com";
    await requestCode(email, "register");
    const right = codeFor(email);
    const wrong = right === "000000" ? "000001" : "000000";
    // The right code is among 20 sent at once, after the 5 attempts are used up.
    const guesses = [...Array.from({ length: 20 }, () => wrong), right];
    const answers = await Promise.allSettled(guesses.map((code) =>
      publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, email, code })));
    expect(answers.every((answer) => answer.status === "rejected")).toBe(true);
  }, 30_000);

  it("limits emailed codes sent at the same moment", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => requestCode("ada@example.com", "register")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(mails).toHaveLength(5);
  });

  it("doesn't tell who has an account", async () => {
    const a = await account("ada");
    await requestCode("ada@example.com", "register");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, email: "ada@example.com", code: codeFor("ada@example.com"), login: a.login });
    // Unknown logins get a salt too, the same each time.
    const salt = async (email: string) => (await fetch(`https://me.test/login?email=${email}`)).json();
    expect(await salt("nobody@example.com")).toEqual(await salt("nobody@example.com"));
    expect(await salt("nobody@example.com")).toMatchObject({ iterations: 600_000 });
    expect((await salt("nobody@example.com")).salt).not.toBe((await salt("other@example.com")).salt);
    await expect(fetchAccount({ email: "nobody@example.com" }, "x")).rejects.toMatchObject({ status: 401 });
    // By email only when signed in.
    expect((await fetch("https://me.test/users?email=ada@example.com")).status).toBe(401);
    expect(await findAccount({ email: "ada@example.com", signer: a.signer })).toMatchObject({ id: a.identity.id });
    // A taken email without its code looks like any wrong code.
    const b = await account("bob");
    await expect(publishAccount(b.signer, { username: "bob", publicKey: b.publicKey, profile: b.profile, email: "ada@example.com", code: "000000" }))
      .rejects.toMatchObject({ status: 400 });
  }, 30_000);

  it("doesn't let one address lock out an account", async () => {
    const a = await account("ada");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, login: a.login });
    const attempt = (ip: string, auth: string) => fetch("https://me.test/login", {
      method: "POST", headers: { "CF-Connecting-IP": ip }, body: JSON.stringify({ username: "ada", auth }),
    });
    for (let i = 0; i < 15; i++) await attempt("1.1.1.1", `wrong-${i}`);
    expect((await attempt("1.1.1.1", "wrong")).status).toBe(429);
    expect((await attempt("2.2.2.2", "wrong")).status).toBe(401);
    expect((await fetchAccount({ username: "ada" }, "correct horse")).id).toBe(a.identity.id);
    // Many addresses together are still limited.
    let last = 0;
    for (let i = 0; i < 60; i++) last = (await attempt(`3.3.3.${i}`, "wrong")).status;
    expect(last).toBe(429);
  }, 60_000);

  it("counts a whole IPv6 /64 as one address", async () => {
    const a = await account("ada");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, login: a.login });
    const attempt = (ip: string) => fetch("https://me.test/login", {
      method: "POST", headers: { "CF-Connecting-IP": ip }, body: JSON.stringify({ username: "ada", auth: "wrong" }),
    });
    for (let i = 1; i <= 10; i++) expect((await attempt(`2001:db8:1:2::${i.toString(16)}`)).status).toBe(401);
    expect((await attempt("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).status).toBe(429);
    expect((await attempt("2001:db8:1:3::1")).status).toBe(401);
  }, 30_000);

  it("refuses a signature meant for another server, and takes old apps' signatures", async () => {
    const a = await account("ada");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile });
    const elsewhere = await authHeader(a.signer, "GET", new URL("https://evil.test/me"));
    expect((await fetch("https://me.test/me", { headers: { "X-MW-Auth": elsewhere } })).status).toBe(401);
    const here = await authHeader(a.signer, "GET", new URL("https://me.test/me"));
    expect((await fetch("https://me.test/me", { headers: { "X-MW-Auth": here } })).status).toBe(200);
    const time = Date.now();
    const empty = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array())));
    const old = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, a.signer.key, new TextEncoder().encode(`GET /me\n${time}\n${empty}`));
    expect((await fetch("https://me.test/me", { headers: { "X-MW-Auth": `${a.identity.id}.${time}.${base64url(new Uint8Array(old))}` } })).status).toBe(200);
  }, 30_000);

  it("counts passwords tried at the same moment", async () => {
    const a = await account("ada");
    await publishAccount(a.signer, { username: "ada", publicKey: a.publicKey, profile: a.profile, login: a.login });
    const body = (auth: string) => ({ method: "POST", body: JSON.stringify({ username: "ada", auth }) });
    const answers = await Promise.all(Array.from({ length: 15 }, (_, i) => fetch("https://me.test/login", body(`wrong-${i}`))));
    expect(answers.filter((r) => r.status === 401)).toHaveLength(10);
    expect(answers.filter((r) => r.status === 429)).toHaveLength(5);
  }, 30_000);

  it("signs in with GitHub: a new account, then its key back from the recovery copy", async () => {
    expect(await serverFeatures()).toEqual({ github: true, githubClientId: "gh-client" });
    const first = await signInOnGitHub(42);
    expect(first).toMatchObject({ github: { id: "42", login: "octo42" }, account: null, reset: null });
    const a = await account("octo42");
    await publishAccount(a.signer, {
      username: "octo42", publicKey: a.publicKey, profile: a.profile, githubToken: first.githubToken, recoveryCopy: base64url(a.pkcs8),
    });
    expect(await ownAccount(a.signer)).toMatchObject({ github: "octo42", recoveryCopy: true });
    // The token works once.
    const b = await account("other");
    await expect(publishAccount(b.signer, { username: "other", publicKey: b.publicKey, profile: b.profile, githubToken: first.githubToken }))
      .rejects.toMatchObject({ status: 401 });

    const again = await signInOnGitHub(42);
    expect(again.account?.id).toBe(a.identity.id);
    expect(again.reset).toMatchObject({ recoveryCopy: true });
    expect(fromBase64url(await fetchRecoveryCopy(again.reset!.token))).toEqual(a.pkcs8);
    // Another GitHub user is someone else.
    expect((await signInOnGitHub(7)).account).toBeNull();
  }, 30_000);

  describe("feedback", () => {
    const feedback = { message: "Nice app", report: "", reply: "", version: "1.2.3", system: "Linux · Chrome · web" };

    it("mails it to the feedback address, with no account", async () => {
      await sendFeedback(feedback);
      const mail = mails.at(-1)!;
      expect(mail.to).toBe("feedback@test");
      expect(mail.subject).toBe("MakeWork feedback (1.2.3)");
      expect(mail.text).toContain("Nice app");
      expect(mail.text).toContain("Linux · Chrome · web");
      expect(mail.replyTo).toBeUndefined();
    });

    it("answers go to the address given, and reports say what they are", async () => {
      await sendFeedback({ ...feedback, message: "", report: "Where: test", reply: "Me@Example.com" });
      const mail = mails.at(-1)!;
      expect(mail.subject).toBe("MakeWork crash report (1.2.3)");
      expect(mail.text).toContain("Where: test");
      expect(mail.replyTo).toBe("me@example.com");
    });

    it("refuses empty feedback and a bad address without mailing", async () => {
      const before = mails.length;
      await expect(sendFeedback({ ...feedback, message: "  " })).rejects.toThrow("empty");
      await expect(sendFeedback({ ...feedback, reply: "nope" })).rejects.toThrow("email");
      expect(mails).toHaveLength(before);
    });

    it("stops one address after its limit", async () => {
      for (let i = 0; i < 10; i++) await sendFeedback(feedback);
      await expect(sendFeedback(feedback)).rejects.toThrow("Too many");
    });

    it("reports the server's version", async () => {
      expect(await userServerVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});
