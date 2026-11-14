// MakeWork's user server: accounts that work on every computer, and private messages waiting for their recipient.
//
// An account is a key pair made on the user's computer; its id comes from the public key. Requests that act as an
// account carry a signature by that key (`X-MW-Auth`), so there are no sessions or cookies here. Password accounts
// also leave their private key here, locked with the password on the user's computer, plus a verifier: the
// SHA-256 of a second key derived from the password. Signing in elsewhere sends that derived key, gets the locked
// key back and unlocks it there. The password itself never arrives here.
//
// People sign in by email (confirmed with an emailed code); usernames are display names anyone may share, told
// apart by a tag from the account id. The password alone doesn't sign in: the locked key is handed out only with a
// second step, a code from the owner's authenticator app when they turned that on, else a code mailed to the account's
// email (the app asks this server only on a device that doesn't hold the account yet). A forgotten password is reset
// with an emailed code; the key then comes back from this server's recovery copy (off unless the owner turns it on; encrypted with RECOVERY_SECRET, so whoever
// runs this server could read it), the owner's recovery key (its locked copy is kept here, unreadable), or a device
// still signed in, which hands the key over sealed to the resetting device. Without any of them the email moves to
// a new account.
//
// Sign in with GitHub runs through here, since GitHub hands out sign-ins only to a server holding the app's secret:
// /github/start sends the person to GitHub, /github/callback learns who they are and hands a one-time code to the
// place the sign-in started from (the desktop app's loopback port, the Android app's link, or the web app's own
// origin), and the app fetches /github/result with its session id and that code. The key then comes back like after a password reset
// (recovery copy, recovery key, or a device).
//
// Friends are mutual (a request, then an accept). Messages from people who aren't friends are refused unless the
// recipient allows strangers, and messages from blocked people always are.
//
// Vaults are small documents encrypted by the app for its own account, such as the list of servers it joined.
//
// Messages are end-to-end encrypted between the two accounts. They wait here only until the recipient confirms
// them, or 30 days. File attachments never come here: members pass them to each other directly.
const usernamePattern = /^[a-z0-9._]{2,32}$/;
const idPattern = /^[A-Za-z0-9_-]{8,64}$/;
const clockSkewMs = 5 * 60_000;
const maxRequestBytes = 256 * 1024;
const maxProfileBytes = 96 * 1024;
const maxMessageBytes = 64 * 1024;
const maxVaultBytes = 128 * 1024;
const vaultNamePattern = /^[a-z0-9-]{1,32}$/;
const maxWaitingPerRecipient = 1000;
const messageLifetimeMs = 30 * 24 * 3_600_000;
const maxFailures = 10;
// From all addresses together, so one address can't lock anyone out.
const maxAccountFailures = 50;
const failureWindowMs = 15 * 60_000;
const hourMs = 3_600_000;
const maxCodesPerAddress = 20;
const maxCodeGuessesPerAddress = 30;
const maxEmailLookupsPerAddress = 30;
// Shown to the app (Settings > About); raise it when deploying a change.
const serverVersion = "1.4.1";
const maxFeedbackChars = 16_000;
const maxFeedbackPerAddress = 10;
// From all addresses together: feedback shares its mail quota with sign-in codes, which must keep working.
const maxFeedbackPerHour = 50;
const maxReportChars = 4000;
const maxReportsPerAccount = 5;
// What the app uses for new logins: answers about unknown accounts look the same.
const defaultLoginIterations = 600_000;
const emailPattern = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const codeLifetimeMs = 15 * 60_000;
const maxCodeAttempts = 5;
const maxCodesPerHour = 5;
const resetLifetimeMs = 30 * 60_000;
const oauthLifetimeMs = 10 * 60_000;
// The Android app's intent filter (AndroidManifest.xml). Another app claiming it would get only the one-time code, which
// is useless without the session id the sign-in started with.
const androidReturn = "com.makework.app://github";
const sessionPattern = /^[A-Za-z0-9_-]{22,64}$/;
// How a device names itself in a sign-in code's email ("Windows · Chrome"): plain words only, since whoever signs in writes it.
const deviceLabelPattern = /^[\p{L}\p{N} ·.-]{1,64}$/u;
const totpStepMs = 30_000;
const totpDigits = 6;
const backupCodeCount = 10;
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof Refusal) return json({ error: e.message, ...e.extra }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the user server." }, 500);
    }
  },
};

class Refusal extends Error {
  // `extra` fields go into the answer next to `error`, for apps that know them.
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = trimEnd(url.pathname, "/") || "/";
  const method = request.method;
  const body = method === "GET" ? "" : await readBody(request);

  if (method === "GET" && path === "/")
    return json({
      makework: "user-server", v: 1, version: serverVersion, name: env.NAME ?? "MakeWork accounts", github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      // Public: the desktop app signs in to GitHub for repositories with it (device flow, no secret involved).
      github_client_id: env.GITHUB_CLIENT_ID || null,
    });
  if (method === "POST" && path === "/feedback") return takeFeedback(request, env, parse(body));
  if (method === "POST" && path === "/report") return reportAccount(request, env, path, body);
  if (method === "PUT" && path === "/me") return publish(request, env, path, body);
  if (method === "GET" && path === "/me") return ownAccount(request, env, path);
  if (method === "DELETE" && path === "/me") return deleteAccount(request, env, path);
  if (method === "POST" && path === "/email/code") return sendCode(request, env, parse(body));
  if (method === "POST" && path === "/reset/start") return startReset(request, env, parse(body));
  if (method === "POST" && path === "/reset/copy") return recoveryCopy(request, env, parse(body));
  if (method === "POST" && path === "/reset/request") return requestFromDevice(env, parse(body));
  if (method === "GET" && path === "/reset/request") return resetRequestStatus(env, url.searchParams);
  if (method === "GET" && path === "/me/resets") return pendingResets(request, env, path);
  if (method === "POST" && path === "/me/resets") return answerReset(request, env, path, body);
  if (method === "GET" && path === "/login") return loginSalt(env, url.searchParams);
  if (method === "GET" && path === "/github/start") return githubStart(env, url);
  if (method === "GET" && path === "/github/callback") return githubCallback(env, url);
  if (method === "GET" && path === "/github/result") return githubResult(env, url.searchParams);
  if (method === "POST" && path === "/login") return login(request, env, parse(body));
  if (method === "GET" && path === "/users") return lookup(request, env, path, url.searchParams);
  if (method === "POST" && path === "/messages") return sendMessage(request, env, path, body);
  if (method === "GET" && path === "/messages") return waitingMessages(request, env, path);
  if (method === "POST" && path === "/messages/ack") return confirmMessages(request, env, path, body);
  if (method === "GET" && path === "/me/relations") return json(await relations(env, await signedBy(request, env, path, "")));
  if (method === "POST" && path === "/me/relations") return changeRelation(request, env, path, body);
  if (method === "PUT" && path === "/me/settings") return changeSettings(request, env, path, body);
  if (method === "POST" && path === "/me/totp/start") return startTotp(request, env, path, body);
  if (method === "POST" && path === "/me/totp/confirm") return confirmTotp(request, env, path, body);
  if (method === "POST" && path === "/me/totp/off") return turnOffTotp(request, env, path, body);
  const vault = path.match(/^\/me\/vault\/([^/]+)$/)?.[1];
  if (vault && method === "GET") return readVault(request, env, path, vault);
  if (vault && method === "PUT") return writeVault(request, env, path, body, vault);
  throw new Refusal(404, "Not found");
}

// Adds or updates the signed-in account. A new account proves it holds the key by signing with it.
async function publish(request, env, path, body) {
  const input = parse(body);
  const publicKey = { x: text(input.publicKey?.x, 64), y: text(input.publicKey?.y, 64) };
  const claimed = authHeader(request).id;
  if (claimed !== await accountId(publicKey)) throw new Refusal(400, "The account id doesn't match its key.");
  if (await env.DB.prepare("SELECT 1 FROM deleted_accounts WHERE id = ?").bind(claimed).first())
    throw new Refusal(410, "This account was deleted.");
  const existing = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(claimed).first();
  if (existing && existing.public_key !== JSON.stringify(publicKey)) throw new Refusal(400, "The account's key can't change.");
  await verifyRequest(request, path, body, publicKey);

  const username = text(input.username, 32);
  if (!usernamePattern.test(username))
    throw new Refusal(400, "Usernames are 2 to 32 characters: lowercase letters, digits, dots and underscores.");
  // A profile written on another device may be newer (name, color and avatar follow the account): keep the newest.
  const incomingAt = Math.max(0, Number(input.profile?.updatedAt) || 0);
  let storedAt = 0;
  try {
    storedAt = Math.max(0, Number(JSON.parse(existing?.profile ?? "{}")?.updatedAt) || 0);
  } catch {
    storedAt = 0;
  }
  const keepProfile = !!existing && storedAt > incomingAt;
  const profile = keepProfile ? existing.profile : JSON.stringify({
    displayName: text(input.profile?.displayName ?? username, 64),
    color: text(input.profile?.color ?? "", 32),
    avatar: text(input.profile?.avatar ?? "", maxProfileBytes),
    updatedAt: Math.max(incomingAt, storedAt),
  });

  let login = existing?.login ?? null;
  let verifier = existing?.verifier ?? null;
  if (input.login) {
    const l = input.login;
    login = JSON.stringify({
      salt: text(l.salt, 64), iterations: Math.max(100_000, Math.min(10_000_000, Number(l.iterations) || 0)),
      locked: {
        salt: text(l.locked?.salt, 64), iv: text(l.locked?.iv, 64), data: text(l.locked?.data, 4096),
        iterations: Number(l.locked?.iterations) || 0,
      },
    });
    verifier = await sha256(text(l.auth, 128));
  }

  // A new email needs its code, or a reset token for it (a fresh account taking over the email of a lost one).
  let email = existing?.email ?? null;
  let takeOver = null;
  const wanted = input.email === undefined ? email : cleanEmail(input.email);
  if (wanted !== email) {
    email = wanted;
    if (input.resetToken !== undefined) {
      takeOver = await resetToken(env, input.resetToken);
      if (takeOver.email !== email) throw new Refusal(400, "That reset was for another email.");
    } else {
      // The code first: only the email's owner may learn that it has an account.
      await limitAddress(request, env, "guess", maxCodeGuessesPerAddress);
      await useCode(env, email, "register", input.code);
      const holder = await env.DB.prepare("SELECT id FROM accounts WHERE email = ? AND id != ?").bind(email, claimed).first();
      if (holder) throw new Refusal(409, "Another account uses that email. Sign in with it, or reset its password.");
    }
  }

  // A GitHub sign-in links that GitHub user to this account (taking it from another account it was linked to).
  let github = existing ? { id: existing.github_id ?? null, login: existing.github_login ?? null } : { id: null, login: null };
  let githubLink = null;
  if (input.githubToken !== undefined) {
    githubLink = await githubToken(env, input.githubToken);
    github = { id: githubLink.github_id, login: githubLink.github_login };
  }

  // undefined keeps it, null removes it.
  let copy = existing?.recovery_copy ?? null;
  let copyOff = existing?.recovery_off ?? 0;
  if (input.recoveryCopy === null) [copy, copyOff] = [null, 1];
  else if (input.recoveryCopy !== undefined) [copy, copyOff] = [await sealCopy(env, text(input.recoveryCopy, 1024)), 0];
  let recoveryLocked = existing?.recovery_locked ?? null;
  if (input.recoveryLocked === null) recoveryLocked = null;
  else if (input.recoveryLocked !== undefined) recoveryLocked = JSON.stringify(lockedKey(input.recoveryLocked));

  const now = Date.now();
  const statements = [];
  if (githubLink) {
    statements.push(env.DB.prepare("UPDATE accounts SET github_id = NULL, github_login = NULL WHERE github_id = ? AND id != ?").bind(github.id, claimed));
    statements.push(env.DB.prepare("DELETE FROM github_tokens WHERE token_hash = ?").bind(githubLink.hash));
  }
  if (takeOver) {
    // The lost account keeps its profile and messages but no longer signs in with this email.
    statements.push(env.DB.prepare("UPDATE accounts SET email = NULL, login = NULL, verifier = NULL, recovery_copy = NULL, recovery_locked = NULL WHERE email = ? AND id != ?")
      .bind(email, claimed));
    statements.push(env.DB.prepare("DELETE FROM reset_tokens WHERE token_hash = ?").bind(takeOver.hash));
  }
  if (existing) {
    statements.push(env.DB.prepare(
      "UPDATE accounts SET username = ?, profile = ?, login = ?, verifier = ?, email = ?, recovery_copy = ?, recovery_off = ?, recovery_locked = ?, "
      + "github_id = ?, github_login = ?, updated_at = ? WHERE id = ?",
    ).bind(username, profile, login, verifier, email, copy, copyOff, recoveryLocked, github.id, github.login, now, claimed));
  } else {
    statements.push(env.DB.prepare(
      "INSERT INTO accounts (id, username, public_key, profile, login, verifier, email, recovery_copy, recovery_off, recovery_locked, "
      + "github_id, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(claimed, username, JSON.stringify(publicKey), profile, login, verifier, email, copy, copyOff, recoveryLocked,
      github.id, github.login, now, now));
  }
  await env.DB.batch(statements);
  return json({ ok: true, created: !existing, profile: JSON.parse(profile) });
}

// What the signed-in account's own settings page shows; never public.
async function ownAccount(request, env, path) {
  const me = await signedBy(request, env, path, "");
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(me).first();
  return json({
    email: row.email, github: row.github_login, hasPassword: !!row.login, recoveryCopy: !!row.recovery_copy, recoveryOff: !!row.recovery_off, recoveryKey: !!row.recovery_locked,
    keepsCopies: !!env.RECOVERY_SECRET, totp: !!row.totp_secret, backupCodes: row.totp_secret ? JSON.parse(row.totp_backup ?? "[]").length : 0,
  });
}

// Removes the account and everything kept here for it or about it. Only its id stays, so it can't be published again.
async function deleteAccount(request, env, path) {
  const me = await signedBy(request, env, path, "");
  const row = await env.DB.prepare("SELECT email FROM accounts WHERE id = ?").bind(me).first();
  const db = env.DB;
  const statements = [
    db.prepare("INSERT OR IGNORE INTO deleted_accounts (id, deleted_at) VALUES (?, ?)").bind(me, Date.now()),
    db.prepare("DELETE FROM messages WHERE recipient = ? OR sender = ?").bind(me, me),
    db.prepare("DELETE FROM vaults WHERE account = ?").bind(me),
    db.prepare("DELETE FROM friends WHERE account = ? OR friend = ?").bind(me, me),
    db.prepare("DELETE FROM friend_requests WHERE sender = ? OR recipient = ?").bind(me, me),
    db.prepare("DELETE FROM blocks WHERE account = ? OR blocked = ?").bind(me, me),
    db.prepare("DELETE FROM turn_grants WHERE account = ?").bind(me),
    db.prepare("DELETE FROM reset_tokens WHERE account = ?").bind(me),
    db.prepare("DELETE FROM reset_requests WHERE account = ?").bind(me),
    db.prepare("DELETE FROM accounts WHERE id = ?").bind(me),
  ];
  if (row?.email) statements.push(db.prepare("DELETE FROM email_codes WHERE email = ?").bind(row.email));
  await db.batch(statements);
  return json({ ok: true });
}

// Always answers the same, so nobody can find out which emails have accounts here.
async function sendCode(request, env, input) {
  const email = cleanEmail(input.email);
  await limitAddress(request, env, "code", maxCodesPerAddress);
  const purpose = input.purpose === "reset" ? "reset" : "register";
  const holder = await env.DB.prepare("SELECT id, login FROM accounts WHERE email = ?").bind(email).first();
  const code = await issueCode(env, email, purpose);

  const name = env.NAME ?? "MakeWork accounts";
  if (purpose === "register" && holder)
    await sendEmail(env, email, "Your MakeWork account", `Someone tried to sign up with this email, but it already has a MakeWork account.\n\nSign in with it, or use "Forgot password" on the sign-in screen.\n\n${name}`);
  else if (purpose === "register")
    await sendEmail(env, email, `Your MakeWork code: ${code}`, `Your code to confirm this email for MakeWork: ${code}\n\nIt works for 15 minutes. If you didn't ask for it, ignore this email.\n\n${name}`);
  else if (holder)
    await sendEmail(env, email, `Reset your MakeWork password: ${code}`, `Your code to reset your MakeWork password: ${code}\n\nIt works for 15 minutes. If you didn't ask for it, ignore this email; your password stays as it is.\n\n${name}`);
  return json({ ok: true });
}

// Makes a new code for the email and purpose ("register", "reset", "login"), replacing the one before, and returns
// it. Only a few an hour for each, so this server can't be used to flood an inbox.
async function issueCode(env, email, purpose) {
  const now = Date.now();
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  // One statement, so requests at the same moment can't all pass the limit (a new code also resets the attempts).
  const hourAgo = now - 3_600_000;
  const stored = await env.DB.prepare(
    "INSERT INTO email_codes (email, purpose, code_hash, expires_at, attempts, sent, sent_since) VALUES (?, ?, ?, ?, 0, 1, ?) "
    + "ON CONFLICT (email, purpose) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, "
    + "sent = CASE WHEN email_codes.sent_since > ? THEN email_codes.sent + 1 ELSE 1 END, "
    + "sent_since = CASE WHEN email_codes.sent_since > ? THEN email_codes.sent_since ELSE excluded.sent_since END "
    + "WHERE email_codes.sent_since <= ? OR email_codes.sent < ? RETURNING 1 AS ok",
  ).bind(email, purpose, await sha256(`${purpose}:${code}`), now + codeLifetimeMs, now, hourAgo, hourAgo, hourAgo, maxCodesPerHour).first();
  if (!stored) throw new Refusal(429, "Too many codes for this email. Try again in an hour.");
  return code;
}

// Feedback and crash reports the person chose to send from the app, mailed to FEEDBACK_TO and not kept here. No
// account needed, so it also works signed out. It only ever goes to that one address, so it can't relay spam.
async function takeFeedback(request, env, input) {
  if (!env.FEEDBACK_TO) throw new Refusal(503, "This user server doesn't take feedback.");
  const message = text(input.message ?? "", maxFeedbackChars).trim();
  const report = text(input.report ?? "", maxFeedbackChars).trim();
  if (!message && !report) throw new Refusal(400, "The feedback is empty.");
  const reply = input.reply ? cleanEmail(input.reply) : null;
  const version = /^[0-9A-Za-z.+-]{1,64}$/.test(input.version) ? input.version : "unknown";
  const system = text(input.system ?? "", 120).replace(/\s+/g, " ");
  await limitAddress(request, env, "feedback", maxFeedbackPerAddress);
  if (await countTry(env, "feedback|all", hourMs) > maxFeedbackPerHour) throw new Refusal(429, "Too much feedback right now. Try again in an hour.");
  const parts = [`Version: ${version}`, `System: ${system || "unknown"}`, `Reply to: ${reply ?? "nobody, sent without an address"}`];
  if (message) parts.push("", message);
  if (report) parts.push("", "--- Crash report ---", report);
  await sendEmail(env, env.FEEDBACK_TO, `MakeWork ${report ? "crash report" : "feedback"} (${version})`, parts.join("\n"), reply);
  return json({ ok: true });
}

// A report about an account, mailed like feedback. Only signed-in accounts can report, so the report can be answered.
async function reportAccount(request, env, path, body) {
  if (!env.FEEDBACK_TO) throw new Refusal(503, "This user server doesn't take reports.");
  const me = await signedBy(request, env, path, body);
  const input = parse(body);
  const reason = text(input.reason ?? "", maxReportChars).trim();
  if (!reason) throw new Refusal(400, "Say what happened.");
  const reported = await env.DB.prepare("SELECT id, username FROM accounts WHERE id = ?").bind(text(input.account, 64)).first();
  if (!reported) throw new Refusal(404, "That account isn't on this user server.");
  if (reported.id === me) throw new Refusal(400, "You can't report your own account.");
  if (await countTry(env, `report|${me}`, hourMs) > maxReportsPerAccount) throw new Refusal(429, "Too many reports. Try again in an hour.");
  if (await countTry(env, "feedback|all", hourMs) > maxFeedbackPerHour) throw new Refusal(429, "Too many reports right now. Try again in an hour.");
  const reporter = await env.DB.prepare("SELECT username, email FROM accounts WHERE id = ?").bind(me).first();
  const parts = [
    `Reported: ${reported.username}·${tagOf(reported.id)} (${reported.id})`,
    `Reported by: ${reporter.username}·${tagOf(me)} (${me}), ${reporter.email ?? "no email"}`,
    "", reason,
  ];
  await sendEmail(env, env.FEEDBACK_TO, `MakeWork account report: ${reported.username}·${tagOf(reported.id)}`, parts.join("\n"), reporter.email ?? null);
  return json({ ok: true });
}

// Checks and uses up an emailed code. Each guess first takes one of the code's attempts in a single statement, so
// many guesses sent at once can't all slip in under the limit before any of them is counted.
async function useCode(env, email, purpose, code) {
  const now = Date.now();
  const row = await env.DB.prepare(
    "UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ? AND attempts < ? AND expires_at >= ? RETURNING code_hash",
  ).bind(email, purpose, maxCodeAttempts, now).first();
  if (!row) {
    const live = await env.DB.prepare("SELECT 1 FROM email_codes WHERE email = ? AND purpose = ? AND expires_at >= ?").bind(email, purpose, now).first();
    throw live ? new Refusal(429, "Too many wrong codes. Ask for a new one.") : new Refusal(400, "That code has expired. Ask for a new one.");
  }
  if (!equal(await sha256(`${purpose}:${String(code ?? "").trim()}`), row.code_hash)) throw new Refusal(400, "That code isn't right.");
  const used = await env.DB.prepare("UPDATE email_codes SET expires_at = 0 WHERE email = ? AND purpose = ? AND expires_at >= ?").bind(email, purpose, now).run();
  if (!used.meta?.changes && !used.changes) throw new Refusal(400, "That code has expired. Ask for a new one.");
}

// An emailed code becomes a reset token, and the ways the key can come back for this account.
async function startReset(request, env, input) {
  const email = cleanEmail(input.email);
  await limitAddress(request, env, "guess", maxCodeGuessesPerAddress);
  await useCode(env, email, "reset", input.code);
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first();
  if (!row) throw new Refusal(404, "There is no account with that email.");
  await dropExpiredTokens(env);
  const token = base64url(crypto.getRandomValues(new Uint8Array(24)));
  await env.DB.prepare("INSERT INTO reset_tokens (token_hash, account, email, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), row.id, email, Date.now() + resetLifetimeMs).run();
  return json({
    token, account: publicAccount(row), recoveryCopy: !!row.recovery_copy && !!env.RECOVERY_SECRET,
    recoveryLocked: row.recovery_locked ? JSON.parse(row.recovery_locked) : null, totp: !!row.totp_secret,
  });
}

// Where a GitHub sign-in's answer may go: the desktop app's one-off loopback port, the Android app's link
// (androidReturn), or the web app at one of its origins (APP_ORIGINS, comma separated). Never an address the starter names freely: whoever starts a sign-in could
// otherwise send someone else the link and collect that person's answer.
function returnTarget(env, url) {
  const port = url.searchParams.get("port");
  if (port !== null) {
    const n = Number(port);
    if (!/^\d{4,5}$/.test(port) || n < 1024 || n > 65535) throw new Refusal(400, "Bad port.");
    return { port: n };
  }
  if (url.searchParams.get("app") === "android") return { app: "android" };
  const origin = url.searchParams.get("origin");
  const allowed = String(env.APP_ORIGINS ?? "https://makework.dev,http://localhost:1420").split(",").map((o) => o.trim()).filter(Boolean);
  if (origin !== null && allowed.includes(origin)) return { origin };
  throw new Refusal(400, "This version of MakeWork can't sign in with GitHub any more. Update it and try again.");
}

async function githubStart(env, url) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw new Refusal(404, "This user server doesn't offer GitHub sign-in.");
  const session = String(url.searchParams.get("session") ?? "");
  if (!sessionPattern.test(session)) throw new Refusal(400, "Bad session.");
  const target = returnTarget(env, url);
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  await env.DB.prepare("DELETE FROM oauth_sessions WHERE created_at < ?").bind(Date.now() - oauthLifetimeMs).run();
  await env.DB.prepare("INSERT INTO oauth_sessions (session_hash, state, created_at, return_to) VALUES (?, ?, ?, ?)")
    .bind(await sha256(session), state, Date.now(), JSON.stringify(target)).run();
  const github = new URL("https://github.com/login/oauth/authorize");
  github.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${url.origin}/github/callback`, state, scope: "read:user", allow_signup: "true",
  }).toString();
  return Response.redirect(github.toString(), 302);
}

// GitHub sends the person back here: who they are, and what the app needs to sign in. The answer is kept under a
// one-time code that only goes to the place the sign-in started from (returnTarget); the app fetches it with that code.
async function githubCallback(env, url) {
  const state = String(url.searchParams.get("state") ?? "");
  const row = await env.DB.prepare("SELECT * FROM oauth_sessions WHERE state = ?").bind(state).first();
  if (!row || row.created_at < Date.now() - oauthLifetimeMs || row.result || !row.return_to) return page("Sign-in expired", "This sign-in has expired. Start again in MakeWork.");
  const target = JSON.parse(row.return_to);
  const answer = async (result) => {
    const once = base64url(crypto.getRandomValues(new Uint8Array(24)));
    await env.DB.prepare("UPDATE oauth_sessions SET result = ?, once_hash = ? WHERE state = ?").bind(JSON.stringify(result), await sha256(once), state).run();
    // Only tells the app's page what to show; the answer itself is fetched with the code.
    const status = result.error ? "error" : "ok";
    if (target.port) return Response.redirect(`http://127.0.0.1:${Number(target.port)}/github?once=${once}&status=${status}`, 302);
    if (target.app === "android") return new Response(null, { status: 302, headers: { Location: `${androidReturn}?once=${once}&status=${status}` } });
    return Response.redirect(`${target.origin}/github-callback.html#once=${once}`, 302);
  };
  if (url.searchParams.get("error")) return answer({ error: "Sign-in was cancelled." });
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get("code"),
      redirect_uri: `${url.origin}/github/callback`,
    }),
  });
  const { access_token: accessToken } = await tokenResponse.json().catch(() => ({}));
  const userResponse = accessToken && await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "makework-user-server" },
  });
  const user = userResponse?.ok ? await userResponse.json() : null;
  if (!user?.id) return answer({ error: "GitHub didn't confirm who you are. Try again." });
  const githubId = String(user.id);
  const now = Date.now();
  await dropExpiredTokens(env);
  const token = base64url(crypto.getRandomValues(new Uint8Array(24)));
  await env.DB.prepare("INSERT INTO github_tokens (token_hash, github_id, github_login, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), githubId, String(user.login), now + resetLifetimeMs).run();
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE github_id = ?").bind(githubId).first();
  // For a linked account, also a reset token, so the key can come back the same ways as after a password reset.
  let reset = null;
  if (account) {
    const resetToken = base64url(crypto.getRandomValues(new Uint8Array(24)));
    await env.DB.prepare("INSERT INTO reset_tokens (token_hash, account, email, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(resetToken), account.id, account.email ?? "", now + resetLifetimeMs).run();
    reset = {
      token: resetToken, recoveryCopy: !!account.recovery_copy && !!env.RECOVERY_SECRET,
      recoveryLocked: account.recovery_locked ? JSON.parse(account.recovery_locked) : null, totp: !!account.totp_secret,
    };
  }
  return answer({
    githubToken: token, github: { id: githubId, login: String(user.login), name: String(user.name ?? user.login) },
    account: account ? publicAccount(account) : null, reset,
  });
}

// The app fetches the answer with its session id and the one-time code that reached it; handed out once.
async function githubResult(env, params) {
  const hash = await sha256(text(params.get("session") ?? "", 64));
  const once = text(params.get("once") ?? "", 64);
  const row = await env.DB.prepare("SELECT result, created_at, once_hash FROM oauth_sessions WHERE session_hash = ?").bind(hash).first();
  if (!row || row.created_at < Date.now() - oauthLifetimeMs) throw new Refusal(404, "This sign-in has expired. Start again.");
  if (!row.result || !row.once_hash || !equal(await sha256(once), row.once_hash)) throw new Refusal(404, "This sign-in has expired. Start again.");
  await env.DB.prepare("DELETE FROM oauth_sessions WHERE session_hash = ?").bind(hash).run();
  const result = JSON.parse(row.result);
  if (result.error) throw new Refusal(400, result.error);
  return json({ status: "done", ...result });
}

// Reset and GitHub tokens past their time, removed whenever new ones are made.
async function dropExpiredTokens(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reset_tokens WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM github_tokens WHERE expires_at < ?").bind(now),
  ]);
}

async function githubToken(env, token) {
  const hash = await sha256(text(token, 64));
  const row = await env.DB.prepare("SELECT * FROM github_tokens WHERE token_hash = ?").bind(hash).first();
  if (!row || row.expires_at < Date.now()) throw new Refusal(401, "This GitHub sign-in has expired. Start again.");
  return { ...row, hash };
}

// A page for the browser, in the look of the app's sign-in pages (app/electron/signInPage.js).
function page(title, message) {
  const escapeHtml = (value) => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(title)} - MakeWork</title>
<style>
  :root { --bg: #020203; --card: #08071d; --text: #ecf6ff; --muted: #acbdcd; --accent: #2f78e4; --error: #e53935; --border: #3d52ae; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #dfe4f4; --card: #ffffff; --text: #0b0e28; --muted: #3c4766; --accent: #2a6ad8; --error: #c62828; --border: #6574c0; }
  }
  * { box-sizing: border-box; }
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { display: flex; flex-direction: column; align-items: center; gap: 12px; width: min(400px, 100%); padding: 32px 24px; border: 2px solid var(--border); border-radius: 2px; background: var(--card); text-align: center; }
  .icon { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 50%; background: color-mix(in srgb, var(--error) 16%, transparent); color: var(--error); }
  .icon svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; }
  h1 { margin: 4px 0 0; font-size: 1.3rem; }
  p { margin: 0; color: var(--muted); }
  .brand { margin-top: 12px; color: var(--accent); font-weight: 700; letter-spacing: 0.02em; }
</style>
<main>
  <div class="icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <div class="brand">MakeWork</div>
</main>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function resetToken(env, token) {
  const hash = await sha256(text(token, 64));
  const row = await env.DB.prepare("SELECT * FROM reset_tokens WHERE token_hash = ?").bind(hash).first();
  if (!row || row.expires_at < Date.now()) throw new Refusal(401, "This reset has expired. Start again.");
  return { ...row, hash };
}

// Hands the key out once per reset (`copy_taken`); the token stays valid for the rest of the reset (asking a device,
// a fresh account taking the email over).
// With an authenticator app turned on, the copy also takes one of its codes: else the email alone would get the key.
async function recoveryCopy(request, env, input) {
  const reset = await resetToken(env, input.token);
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(reset.account).first();
  if (!row?.recovery_copy || !env.RECOVERY_SECRET) throw new Refusal(404, "This account has no recovery copy here.");
  if (row.totp_secret) await checkTotp(request, env, row, input.totp);
  // Opened first: a copy that can't be opened leaves the reset as it was.
  const privateKey = await openCopy(env, row.recovery_copy);
  const taken = await env.DB.prepare("UPDATE reset_tokens SET copy_taken = 1 WHERE token_hash = ? AND copy_taken IS NULL RETURNING token_hash")
    .bind(reset.hash).first();
  if (!taken) throw new Refusal(401, "This reset already took the recovery copy. Start again.");
  // The notice is a courtesy: mail being down must not cost the person their key, the copy is already taken.
  if (row.email) await sendEmail(env, row.email, "Your MakeWork account was restored", `Your MakeWork account's key was restored from the recovery copy, for a password reset or a sign-in with GitHub.\n\nIf that wasn't you, secure your email and GitHub account, then reset your password.\n\n${env.NAME ?? "MakeWork accounts"}`)
    .catch((e) => console.error("Restore notice not sent:", e));
  return json({ privateKey });
}

async function requestFromDevice(env, input) {
  const reset = await resetToken(env, input.token);
  const publicKey = { x: text(input.publicKey?.x, 64), y: text(input.publicKey?.y, 64) };
  const id = base64url(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare("DELETE FROM reset_requests WHERE account = ? AND created_at < ?").bind(reset.account, Date.now() - resetLifetimeMs).run();
  await env.DB.prepare("INSERT INTO reset_requests (id, account, token_hash, public_key, status, created_at, device) VALUES (?, ?, ?, ?, 'waiting', ?, ?)")
    .bind(id, reset.account, reset.hash, JSON.stringify(publicKey), Date.now(), input.device ? text(input.device, 64) : null).run();
  return json({ id });
}

async function resetRequestStatus(env, params) {
  const reset = await resetToken(env, params.get("token"));
  const row = await env.DB.prepare("SELECT status, sealed FROM reset_requests WHERE id = ? AND token_hash = ?")
    .bind(String(params.get("id") ?? ""), reset.hash).first();
  if (!row) throw new Refusal(404, "No such request.");
  return json({ status: row.status, sealed: row.sealed });
}

async function pendingResets(request, env, path) {
  const me = await signedBy(request, env, path, "");
  const { results } = await env.DB.prepare("SELECT id, public_key, created_at, device FROM reset_requests WHERE account = ? AND status = 'waiting' AND created_at > ?")
    .bind(me, Date.now() - resetLifetimeMs).all();
  return json({ requests: results.map((r) => ({ id: r.id, publicKey: JSON.parse(r.public_key), at: r.created_at, device: r.device })) });
}

// A signed-in device approves (with the key sealed to the requester) or denies.
async function answerReset(request, env, path, body) {
  const me = await signedBy(request, env, path, body);
  const input = parse(body);
  const approve = input.sealed !== undefined;
  const result = await env.DB.prepare("UPDATE reset_requests SET status = ?, sealed = ? WHERE id = ? AND account = ? AND status = 'waiting'")
    .bind(approve ? "approved" : "denied", approve ? text(input.sealed, 4096) : null, text(input.id, 64), me).run();
  if (!result.meta?.changes && !result.changes) throw new Refusal(404, "That request is gone.");
  return json({ ok: true });
}

// Accounts from before emails sign in by username, as long as no other account shares it.
async function byLogin(env, input) {
  if (input.email) return env.DB.prepare("SELECT * FROM accounts WHERE email = ?").bind(cleanEmail(input.email)).first();
  const username = String(input.username ?? "").toLowerCase();
  const { results } = await env.DB.prepare("SELECT * FROM accounts WHERE username = ? AND email IS NULL LIMIT 2").bind(username).all();
  return results.length === 1 ? results[0] : null;
}

async function loginSalt(env, params) {
  const email = params.get("email");
  const row = await byLogin(env, { email, username: params.get("username") });
  if (row?.login) {
    const { salt, iterations } = JSON.parse(row.login);
    return json({ salt, iterations });
  }
  // The same answer as for an account: the same salt each time, so nobody can tell which logins exist.
  const seed = `makework-login-salt:${await saltSecret(env)}:${email ? cleanEmail(email) : String(params.get("username") ?? "").toLowerCase()}`;
  return json({ salt: base64url(fromBase64url(await sha256(seed)).slice(0, 16)), iterations: defaultLoginIterations });
}

// Counts one more try for `key` in the current window and returns how many there were. The try counts before whatever
// it is for, in one statement, so requests at the same moment can't share one.
async function countTry(env, key, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const { count } = await env.DB.prepare(
    "INSERT INTO failures (username, count, since) VALUES (?, 1, ?) ON CONFLICT (username) DO UPDATE SET "
    + "count = CASE WHEN failures.since > ? THEN failures.count + 1 ELSE 1 END, "
    + "since = CASE WHEN failures.since > ? THEN failures.since ELSE excluded.since END RETURNING count",
  ).bind(key, now, windowStart, windowStart).first();
  if (count === 1) await env.DB.prepare("DELETE FROM failures WHERE since < ?").bind(now - 24 * hourMs).run();
  return count;
}

// One client's address: IPv6 clients are handed a whole /64 and could change address for every request.
function clientAddress(request) {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!address.includes(":")) return address;
  const [head, tail = ""] = address.toLowerCase().split("::");
  const start = head ? head.split(":") : [];
  const end = tail ? tail.split(":") : [];
  return [...start, ...new Array(Math.max(0, 8 - start.length - end.length)).fill("0"), ...end].slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16)).join(":");
}

const addressOf = (request) => sha256(clientAddress(request));

// A random secret of this server's, made on first use: the fake login salts must not be predictable.
async function saltSecret(env) {
  const made = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT OR IGNORE INTO server_secrets (name, value) VALUES ('login-salt', ?)").bind(made).run();
  return (await env.DB.prepare("SELECT value FROM server_secrets WHERE name = 'login-salt'").first()).value;
}

async function limitAddress(request, env, what, max) {
  if (await countTry(env, `${what}|${await addressOf(request)}`, hourMs) > max) throw new Refusal(429, "Too many requests from this address. Try again in an hour.");
}

async function login(request, env, input) {
  const username = input.email ? cleanEmail(input.email) : text(input.username, 32).toLowerCase();
  const fromHere = `login|${username}|${await addressOf(request)}`;
  const fromAnywhere = `account|${username}`;
  const tooMany = () => new Refusal(429, "Too many wrong passwords. Try again in 15 minutes.");
  // An address over its limit stops here and doesn't count against the account.
  if (await countTry(env, fromHere, failureWindowMs) > maxFailures) throw tooMany();
  if (await countTry(env, fromAnywhere, failureWindowMs) > maxAccountFailures) throw tooMany();

  const row = await byLogin(env, input);
  const matches = row?.verifier && equal(await sha256(text(input.auth, 128)), row.verifier);
  if (!matches) throw new Refusal(401, input.email ? "Wrong email or password." : "Wrong username or password.");
  await env.DB.prepare("DELETE FROM failures WHERE username IN (?, ?)").bind(fromAnywhere, fromHere).run();
  // Accounts from before emails, without an authenticator app, have nowhere to send a code and sign in with the
  // password alone.
  if (row.totp_secret) await checkTotp(request, env, row, input.totp);
  else if (row.email) await confirmSignIn(request, env, row.email, input);
  return json({ account: { ...publicAccount(row), locked: JSON.parse(row.login).locked } });
}

// The second step of a password sign-in, after the password matched: without a code one is mailed to the account's
// email and the sign-in is refused; with one, it must be that code. A wrong password never gets this far, so no
// mail tells anyone but the password's holder that the account exists.
async function confirmSignIn(request, env, email, input) {
  if (input.code !== undefined) {
    await limitAddress(request, env, "guess", maxCodeGuessesPerAddress);
    await useCode(env, email, "login", input.code);
    return;
  }
  await limitAddress(request, env, "code", maxCodesPerAddress);
  const code = await issueCode(env, email, "login");
  const device = typeof input.device === "string" && deviceLabelPattern.test(input.device) ? ` on ${input.device}` : "";
  await sendEmail(env, email, `Your MakeWork sign-in code: ${code}`,
    `Your code to finish signing in to MakeWork${device}: ${code}\n\nIt works for 15 minutes. Don't give it to anyone.\n\n`
    + `If you didn't just try to sign in, someone has your password. They can't get in without this code; use "Forgot password" on the sign-in screen to set a new one.\n\n${env.NAME ?? "MakeWork accounts"}`);
  // Apps from before sign-in codes show this message; newer ones read `needsCode` and ask for the code.
  throw new Refusal(403, "We emailed you a code to confirm this sign-in. Update MakeWork to enter it.", { needsCode: true });
}

// Authenticator app setup, step 1: a new secret, kept aside until a code from the app shows it was added there.
async function startTotp(request, env, path, body) {
  const me = await signedBy(request, env, path, body);
  const row = await env.DB.prepare("SELECT totp_secret, username, email FROM accounts WHERE id = ?").bind(me).first();
  if (row.totp_secret) throw new Refusal(409, "An authenticator app is already on. Turn it off first.");
  const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
  await env.DB.prepare("UPDATE accounts SET totp_pending = ? WHERE id = ?").bind(secret, me).run();
  const label = encodeURIComponent(`MakeWork:${row.email ?? `${row.username}·${tagOf(me)}`}`);
  return json({ secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=MakeWork&algorithm=SHA1&digits=${totpDigits}&period=${totpStepMs / 1000}` });
}

// Step 2: a code from the app turns it on. The answer holds the backup codes, shown to the owner once.
async function confirmTotp(request, env, path, body) {
  const me = await signedBy(request, env, path, body);
  const input = parse(body);
  await limitAddress(request, env, "guess", maxCodeGuessesPerAddress);
  const row = await env.DB.prepare("SELECT totp_pending, totp_secret FROM accounts WHERE id = ?").bind(me).first();
  if (row.totp_secret) throw new Refusal(409, "An authenticator app is already on.");
  if (!row.totp_pending) throw new Refusal(400, "Start setting up the authenticator app again.");
  const step = await matchingStep(row.totp_pending, input.code, 0);
  if (step === null) throw new Refusal(400, "That code isn't right. Check the time on your phone.");
  const codes = Array.from({ length: backupCodeCount }, newBackupCode);
  const hashes = await Promise.all(codes.map((c) => sha256(`backup:${c.replace("-", "")}`)));
  await env.DB.prepare("UPDATE accounts SET totp_secret = totp_pending, totp_pending = NULL, totp_step = ?, totp_backup = ? WHERE id = ?")
    .bind(step, JSON.stringify(hashes), me).run();
  return json({ backupCodes: codes });
}

// Takes a current code or a backup code, so a lost phone alone can't stop the owner from turning it off.
async function turnOffTotp(request, env, path, body) {
  const me = await signedBy(request, env, path, body);
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(me).first();
  if (!row.totp_secret) return json({ ok: true });
  await checkTotp(request, env, row, parse(body).code);
  await env.DB.prepare("UPDATE accounts SET totp_secret = NULL, totp_pending = NULL, totp_step = 0, totp_backup = NULL WHERE id = ?").bind(me).run();
  return json({ ok: true });
}

// A code from the account's authenticator app, or one of its backup codes, each taken once. Without one the app is
// told to ask for it (`needsTotp`).
async function checkTotp(request, env, row, code) {
  if (code === undefined || code === null || code === "")
    throw new Refusal(403, "Enter the code from your authenticator app. Update MakeWork if it doesn't ask for one.", { needsTotp: true });
  await limitAddress(request, env, "guess", maxCodeGuessesPerAddress);
  if (await countTry(env, `totp|${row.id}`, failureWindowMs) > maxFailures) throw new Refusal(429, "Too many wrong codes. Try again in 15 minutes.");
  const given = String(code).trim();
  if (/^\d+$/.test(given)) {
    const step = await matchingStep(row.totp_secret, given, row.totp_step);
    // One statement, so the same code sent twice at once is taken only once.
    const taken = step !== null && await env.DB.prepare("UPDATE accounts SET totp_step = ? WHERE id = ? AND totp_step < ? RETURNING 1 AS ok")
      .bind(step, row.id, step).first();
    if (!taken) throw new Refusal(400, "That code isn't right. Wait for the next one and try again.");
  } else {
    const hashes = JSON.parse(row.totp_backup ?? "[]");
    const hash = await sha256(`backup:${given.toLowerCase().replaceAll(/[^a-z2-7]/g, "")}`);
    const index = hashes.findIndex((h) => equal(h, hash));
    if (index < 0) throw new Refusal(400, "That backup code isn't right, or it was used already.");
    const left = hashes.toSpliced(index, 1);
    const used = await env.DB.prepare("UPDATE accounts SET totp_backup = ? WHERE id = ? AND totp_backup = ?")
      .bind(JSON.stringify(left), row.id, row.totp_backup).run();
    if (!used.meta?.changes && !used.changes) throw new Refusal(400, "That backup code isn't right, or it was used already.");
  }
  await env.DB.prepare("DELETE FROM failures WHERE username = ?").bind(`totp|${row.id}`).run();
}

// The time step whose code is `code`, one step either side for clocks that are a little off, and only steps after
// `after`; null when none matches.
async function matchingStep(secret, code, after) {
  const given = String(code ?? "").trim();
  if (!/^\d{6}$/.test(given)) return null;
  const now = Math.floor(Date.now() / totpStepMs);
  const key = await crypto.subtle.importKey("raw", fromBase32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= after) continue;
    if (equal(await totpCode(key, step), given)) return step;
  }
  return null;
}

async function totpCode(key, step) {
  const counter = new DataView(new ArrayBuffer(8));
  counter.setUint32(0, Math.floor(step / 2 ** 32));
  counter.setUint32(4, step % 2 ** 32);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
  const offset = mac[19] & 0xf;
  const value = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(value % 10 ** totpDigits).padStart(totpDigits, "0");
}

// Ten letters and digits from base32, shown in two groups ("k3v7q-xm2pd").
function newBackupCode() {
  const letters = base32(crypto.getRandomValues(new Uint8Array(7))).slice(0, 10).toLowerCase();
  return `${letters.slice(0, 5)}-${letters.slice(5)}`;
}

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += base32Alphabet[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text.toUpperCase()) {
    const index = base32Alphabet.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// By id, by email, or by username and tag ("ada" and "4f2a" for ada·4f2a).
// By email only for signed-in accounts, a few times an hour: finding a friend, not testing a list of addresses.
async function lookup(request, env, path, params) {
  const username = params.get("username");
  const email = params.get("email");
  let row = null;
  if (email) {
    await signedBy(request, env, path, "");
    await limitAddress(request, env, "lookup", maxEmailLookupsPerAddress);
    row = await env.DB.prepare("SELECT * FROM accounts WHERE email = ?").bind(cleanEmail(email)).first();
  } else if (username) {
    const tag = String(params.get("tag") ?? "").toLowerCase();
    const { results } = await env.DB.prepare("SELECT * FROM accounts WHERE username = ?").bind(username.toLowerCase()).all();
    row = results.find((r) => tagOf(r.id) === tag) ?? null;
  } else row = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(String(params.get("id") ?? "")).first();
  if (!row) throw new Refusal(404, "No such account.");
  return json({ account: publicAccount(row) });
}

async function sendMessage(request, env, path, body) {
  const sender = await signedBy(request, env, path, body);
  const input = parse(body);
  const id = text(input.id, 64);
  const to = text(input.to, 64);
  const message = text(input.body, maxMessageBytes);
  if (!idPattern.test(id) || !idPattern.test(to)) throw new Refusal(400, "Bad message id or recipient.");
  const now = Date.now();
  await env.DB.prepare("DELETE FROM messages WHERE created_at < ?").bind(now - messageLifetimeMs).run();
  const recipient = await env.DB.prepare("SELECT allow_strangers FROM accounts WHERE id = ?").bind(to).first();
  if (!recipient) throw new Refusal(404, "No such account.");
  // Blocked people get the same answer as strangers, so they can't tell.
  const blocked = await env.DB.prepare("SELECT 1 FROM blocks WHERE account = ? AND blocked = ?").bind(to, sender).first();
  const friends = await env.DB.prepare("SELECT 1 FROM friends WHERE account = ? AND friend = ?").bind(to, sender).first();
  if (blocked || (!friends && !recipient.allow_strangers))
    throw new Refusal(403, "They only accept messages from friends. Send them a friend request.");
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient = ?").bind(to).first();
  if (waiting.n >= maxWaitingPerRecipient) throw new Refusal(429, "Their inbox is full until they come online.");
  // The same id again is the same message resent.
  await env.DB.prepare("INSERT OR IGNORE INTO messages (id, recipient, sender, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, to, sender, message, now).run();
  return json({ ok: true });
}

async function waitingMessages(request, env, path) {
  const me = await signedBy(request, env, path, "");
  const { results } = await env.DB.prepare(
    "SELECT id, sender, body, created_at FROM messages WHERE recipient = ? ORDER BY created_at LIMIT 200",
  ).bind(me).all();
  return json({
    messages: results.map((m) => ({ id: m.id, from: m.sender, body: m.body, at: m.created_at })),
    relations: await relations(env, me),
  });
}

async function confirmMessages(request, env, path, body) {
  const me = await signedBy(request, env, path, body);
  const { ids: list } = parse(body);
  const ids = Array.isArray(list) ? list.slice(0, 200).map((id) => text(id, 64)) : [];
  if (ids.length) {
    await env.DB.prepare(`DELETE FROM messages WHERE recipient = ? AND id IN (${ids.map(() => "?").join(",")})`)
      .bind(me, ...ids).run();
  }
  return json({ ok: true });
}

async function readVault(request, env, path, name) {
  const me = await signedBy(request, env, path, "");
  const row = await env.DB.prepare("SELECT data, rev FROM vaults WHERE account = ? AND name = ?").bind(me, name).first();
  return json({ data: row?.data ?? null, rev: row?.rev ?? 0 });
}

// Written only over the revision the app read; otherwise 409 and the app merges with the newer one.
async function writeVault(request, env, path, body, name) {
  const me = await signedBy(request, env, path, body);
  if (!vaultNamePattern.test(name)) throw new Refusal(400, "Bad vault name.");
  const input = parse(body);
  const data = text(input.data, maxVaultBytes);
  const rev = Number(input.rev);
  if (!Number.isInteger(rev) || rev < 0) throw new Refusal(400, "Bad revision.");
  const now = Date.now();
  const result = rev === 0
    ? await env.DB.prepare("INSERT OR IGNORE INTO vaults (account, name, data, rev, updated_at) VALUES (?, ?, ?, 1, ?)")
      .bind(me, name, data, now).run()
    : await env.DB.prepare("UPDATE vaults SET data = ?, rev = rev + 1, updated_at = ? WHERE account = ? AND name = ? AND rev = ?")
      .bind(data, now, me, name, rev).run();
  if (!result.meta?.changes && !result.changes) throw new Refusal(409, "Changed meanwhile.");
  return json({ rev: rev + 1 });
}

async function relations(env, me) {
  const people = async (sql) => (await env.DB.prepare(sql).bind(me).all()).results.map(publicAccount);
  const settings = await env.DB.prepare("SELECT allow_strangers FROM accounts WHERE id = ?").bind(me).first();
  return {
    friends: await people("SELECT a.* FROM friends f JOIN accounts a ON a.id = f.friend WHERE f.account = ?"),
    incoming: await people("SELECT a.* FROM friend_requests r JOIN accounts a ON a.id = r.sender WHERE r.recipient = ?"),
    outgoing: await people("SELECT a.* FROM friend_requests r JOIN accounts a ON a.id = r.recipient WHERE r.sender = ?"),
    blocked: await people("SELECT a.* FROM blocks b JOIN accounts a ON a.id = b.blocked WHERE b.account = ?"),
    allowStrangers: !!settings?.allow_strangers,
  };
}

// request, accept, remove (unfriend, decline or cancel a request), block, unblock.
async function changeRelation(request, env, path, body) {
  const me = await signedBy(request, env, path, body);
  const input = parse(body);
  const other = text(input.id, 64);
  if (other === me) throw new Refusal(400, "That's you.");
  if (!(await env.DB.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(other).first())) throw new Refusal(404, "No such account.");
  const now = Date.now();
  const db = env.DB;
  const unfriend = () => db.batch([
    db.prepare("DELETE FROM friends WHERE (account = ? AND friend = ?) OR (account = ? AND friend = ?)").bind(me, other, other, me),
    db.prepare("DELETE FROM friend_requests WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)").bind(me, other, other, me),
  ]);
  const befriend = () => db.batch([
    db.prepare("INSERT OR IGNORE INTO friends (account, friend, since) VALUES (?, ?, ?)").bind(me, other, now),
    db.prepare("INSERT OR IGNORE INTO friends (account, friend, since) VALUES (?, ?, ?)").bind(other, me, now),
    db.prepare("DELETE FROM friend_requests WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)").bind(me, other, other, me),
  ]);
  const theyAsked = () => db.prepare("SELECT 1 FROM friend_requests WHERE sender = ? AND recipient = ?").bind(other, me).first();

  switch (input.action) {
    case "request": {
      if (await db.prepare("SELECT 1 FROM blocks WHERE account = ? AND blocked = ?").bind(me, other).first())
        throw new Refusal(400, "Unblock them first.");
      if (await db.prepare("SELECT 1 FROM friends WHERE account = ? AND friend = ?").bind(me, other).first()) break;
      if (await theyAsked()) {
        await befriend();
        break;
      }
      // Someone who blocked you never sees your request, and you can't tell.
      if (await db.prepare("SELECT 1 FROM blocks WHERE account = ? AND blocked = ?").bind(other, me).first()) break;
      await db.prepare("INSERT OR IGNORE INTO friend_requests (sender, recipient, created_at) VALUES (?, ?, ?)").bind(me, other, now).run();
      break;
    }
    case "accept":
      if (!(await theyAsked())) throw new Refusal(404, "They haven't sent you a friend request.");
      await befriend();
      break;
    case "remove":
      await unfriend();
      break;
    case "block":
      await unfriend();
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO blocks (account, blocked, created_at) VALUES (?, ?, ?)").bind(me, other, now),
        db.prepare("DELETE FROM messages WHERE recipient = ? AND sender = ?").bind(me, other),
      ]);
      break;
    case "unblock":
      await db.prepare("DELETE FROM blocks WHERE account = ? AND blocked = ?").bind(me, other).run();
      break;
    default:
      throw new Refusal(400, "Unknown action.");
  }
  return json(await relations(env, me));
}

async function changeSettings(request, env, path, body) {
  const me = await signedBy(request, env, path, body);
  const input = parse(body);
  if (typeof input.allowStrangers === "boolean")
    await env.DB.prepare("UPDATE accounts SET allow_strangers = ? WHERE id = ?").bind(input.allowStrangers ? 1 : 0, me).run();
  return json(await relations(env, me));
}

// The account that signed the request; it must already be here.
async function signedBy(request, env, path, body) {
  const { id } = authHeader(request);
  const row = await env.DB.prepare("SELECT public_key FROM accounts WHERE id = ?").bind(id).first();
  if (!row) throw new Refusal(401, "This account isn't on this user server yet.");
  await verifyRequest(request, path, body, JSON.parse(row.public_key));
  return id;
}

function authHeader(request) {
  const [id, time, signature] = (request.headers.get("X-MW-Auth") ?? "").split(".");
  if (!id || !time || !signature) throw new Refusal(401, "This request isn't signed.");
  return { id, time, signature };
}

// The signature covers the method, host, path, time and body, and is accepted for a few minutes.
async function verifyRequest(request, path, body, publicKey) {
  const { time, signature } = authHeader(request);
  if (Math.abs(Date.now() - Number(time)) > clockSkewMs) throw new Refusal(401, "The request's time is off. Check the computer's clock.");
  const proof = `${path}\n${time}\n${await sha256(body)}`;
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", ...publicKey }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signedText = (text) => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64url(signature), new TextEncoder().encode(text));
  let valid = false;
  try {
    // Current apps sign this server's name too, so another server they use can't pass their requests on to this one.
    // The second form is apps from before that.
    valid = await signedText(`${request.method} ${new URL(request.url).host}${proof}`) || await signedText(`${request.method} ${proof}`);
  } catch {
    // Malformed signature.
  }
  if (!valid) throw new Refusal(401, "The request's signature doesn't match the account.");
}

// Same as the app's core/identity.ts: the first 16 bytes of the SHA-256 of the public key, base64url.
async function accountId(publicKey) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`P-256:${publicKey.x}:${publicKey.y}`));
  return base64url(new Uint8Array(hash).slice(0, 16));
}

function publicAccount(row) {
  return {
    id: row.id, username: row.username, tag: tagOf(row.id), publicKey: JSON.parse(row.public_key), profile: JSON.parse(row.profile),
    hasPassword: !!row.login, createdAt: row.created_at,
  };
}

// Same as the app's core/identity.ts `accountTag`: the first two bytes of the account id as hex.
function tagOf(id) {
  return [...fromBase64url(id).slice(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanEmail(value) {
  const email = text(value, 254).trim().toLowerCase();
  if (!emailPattern.test(email)) throw new Refusal(400, "That doesn't look like an email address.");
  return email;
}

function lockedKey(l) {
  return { salt: text(l?.salt, 64), iv: text(l?.iv, 64), data: text(l?.data, 4096), iterations: Number(l?.iterations) || 0 };
}

// The recovery copy: the account key (PKCS#8, base64url) encrypted with this server's secret.
async function copyKey(env) {
  if (!env.RECOVERY_SECRET) throw new Refusal(400, "This user server doesn't keep recovery copies.");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`makework-recovery:${env.RECOVERY_SECRET}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealCopy(env, privateKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await copyKey(env), new TextEncoder().encode(privateKey));
  return JSON.stringify({ iv: base64url(iv), data: base64url(new Uint8Array(data)) });
}

async function openCopy(env, sealed) {
  const { iv, data } = JSON.parse(sealed);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv) }, await copyKey(env), fromBase64url(data));
  return new TextDecoder().decode(plain);
}

// The one place mail leaves: Resend's HTTP API (RESEND_API_KEY secret), from MAIL_FROM on a domain verified there.
// Without a key (local runs) the message is printed instead.
async function sendEmail(env, to, subject, body, replyTo = null) {
  if (!env.RESEND_API_KEY) {
    console.log(`Email to ${to}: ${subject}\n${body}`);
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `MakeWork <${env.MAIL_FROM ?? "accounts@makework.dev"}>`, to: [to], subject, text: body,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!response.ok) {
    console.error("Sending email failed:", response.status, await response.text().catch(() => ""));
    throw new Refusal(502, "The email couldn't be sent. Try again later.");
  }
}

async function readBody(request) {
  const body = await request.text();
  if (body.length > maxRequestBytes) throw new Refusal(413, "Request too large.");
  return body;
}

function parse(body) {
  try {
    const value = JSON.parse(body);
    if (value && typeof value === "object") return value;
  } catch {
    // Answered below.
  }
  throw new Refusal(400, "The request isn't JSON.");
}

function text(value, max) {
  if (typeof value !== "string" || value.length > max) throw new Refusal(400, "A field is missing or too long.");
  return value;
}

async function sha256(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return trimEnd(btoa(binary).replaceAll("+", "-").replaceAll("/", "_"), "=");
}

// `text` without the run of characters from `chars` at its end (the same as app/electron/text.js). A loop, not a
// pattern like /x+$/: without a start anchor that is tried again from every position.
function trimEnd(text, chars) {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

function fromBase64url(value) {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.codePointAt(0));
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-MW-Auth",
  "Access-Control-Max-Age": "86400",
};

function json(value, status = 200) {
  return Response.json(value, { status, headers: { ...cors, "Cache-Control": "no-store" } });
}
