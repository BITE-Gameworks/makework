// Hands MakeWork clients short-lived Cloudflare TURN credentials, for members who can't reach each other directly
// or through another member. The TURN key's API token stays here as a secret.
//
// Spending cap: before handing out credentials it checks this month's TURN traffic and refuses above CAP_GB, so
// usage stays inside Cloudflare's free 1,000 GB. Credentials last 30 minutes, so a cut-off takes effect within that.
//
// Only accounts of the user server get credentials: the request is signed with the account's key (the same
// `X-MW-Auth` as the user server, checked against the key in its database), and each account and address gets a
// few per hour, so nobody can collect credentials in bulk.
const ttl = 1800;
const defaultCapGb = 500;
const usageCacheMs = 5 * 60_000;
const clockSkewMs = 5 * 60_000;
const hourMs = 3_600_000;

let usage = { bytes: 0, at: 0 };

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return new Response("Not found", { status: 404, headers: cors });

    const account = await signedBy(request, env);
    if (!account) return Response.json({ iceServers: [], ttl: 600, reason: "not signed by an account" }, { status: 401, headers: noStore });
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const now = Date.now();
    // The grant is written first and the hour's grants counted with it, so requests sent all at once can't all pass
    // the count before any of them is written. A request refused later on takes its grant back.
    const grant = await env.DB.prepare("INSERT INTO turn_grants (account, ip, created_at) VALUES (?, ?, ?) RETURNING rowid AS id")
      .bind(account, ip, now).first();
    const giveBack = () => env.DB.prepare("DELETE FROM turn_grants WHERE rowid = ?").bind(grant.id).run();
    const count = async (column, value) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM turn_grants WHERE ${column} = ? AND created_at > ? AND rowid <= ?`).bind(value, now - hourMs, grant.id).first()).n;
    if (await count("account", account) > Number(env.PER_ACCOUNT_HOUR ?? 6) || await count("ip", ip) > Number(env.PER_IP_HOUR ?? 20)) {
      await giveBack();
      return Response.json({ iceServers: [], ttl: 600, reason: "too many requests" }, { status: 429, headers: noStore });
    }

    const capBytes = Number(env.CAP_GB ?? defaultCapGb) * 1e9;
    let used;
    try {
      used = await monthlyBytes(env);
    } catch (e) {
      // Unknown usage could mean a bill, so no credentials until it can be checked.
      console.error("TURN usage not available:", e);
      await giveBack();
      return Response.json({ iceServers: [], ttl: 600, reason: "usage unknown" }, { headers: noStore });
    }
    if (used >= capBytes) {
      await giveBack();
      return Response.json({ iceServers: [], ttl: 3600, reason: "monthly cap reached" }, { headers: noStore });
    }

    // Cloudflare unreachable, refusing or answering oddly: no credentials, and the grant goes back (below).
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl }),
      },
    ).catch((e) => {
      console.error("TURN credentials not fetched:", e);
      return null;
    });
    const { iceServers } = response?.ok ? await response.json().catch(() => ({})) : {};
    if (!Array.isArray(iceServers)) {
      await giveBack();
      return Response.json({ iceServers: [], ttl: 600, reason: "TURN credentials not available" }, { status: 502, headers: noStore });
    }
    await env.DB.prepare("DELETE FROM turn_grants WHERE created_at < ?").bind(now - hourMs).run();
    // Browsers block port 53, so those URLs only time out.
    const usable = iceServers.map((server) => ({
      ...server,
      urls: [server.urls].flat().filter((url) => !/:53(\?|$)/.test(url)),
    }));
    return Response.json({ iceServers: usable, ttl }, { headers: noStore });
  },
};

// The account that signed the request, or null. Same scheme as the user server: "METHOD host+path\ntime\nsha256(body)"
// signed with the account's ECDSA P-256 key, accepted for a few minutes.
async function signedBy(request, env) {
  const [id, time, signature] = (request.headers.get("X-MW-Auth") ?? "").split(".");
  if (!id || !time || !signature || Math.abs(Date.now() - Number(time)) > clockSkewMs) return null;
  const row = await env.DB.prepare("SELECT public_key FROM accounts WHERE id = ?").bind(id).first();
  if (!row) return null;
  const path = trimEnd(new URL(request.url).pathname, "/") || "/";
  const proof = `${path}\n${time}\n${await sha256("")}`;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", ...JSON.parse(row.public_key) },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signedText = (text) => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64url(signature), new TextEncoder().encode(text));
    // The second form is apps from before they signed the host.
    const valid = await signedText(`${request.method} ${new URL(request.url).host}${proof}`) || await signedText(`${request.method} ${proof}`);
    return valid ? id : null;
  } catch {
    return null;
  }
}

async function sha256(value) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of hash) binary += String.fromCodePoint(byte);
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

// TURN bytes in and out since the first of this month (UTC), from Cloudflare's analytics.
async function monthlyBytes(env) {
  if (Date.now() - usage.at < usageCacheMs) return usage.bytes;
  const now = new Date();
  const first = `${now.toISOString().slice(0, 8)}01`;
  const today = now.toISOString().slice(0, 10);
  const query = `query ($account: String!, $key: String!, $from: Date!, $to: Date!) {
    viewer { accounts(filter: { accountTag: $account }) {
      callsTurnUsageAdaptiveGroups(limit: 10000, filter: { keyId: $key, date_geq: $from, date_leq: $to }) {
        sum { egressBytes ingressBytes }
      }
    } }
  }`;
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { account: env.ACCOUNT_ID, key: env.TURN_KEY_ID, from: first, to: today } }),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(JSON.stringify(body.errors ?? response.status));
  const groups = body.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups;
  if (!Array.isArray(groups)) throw new Error("No usage data in the answer");
  const bytes = groups.reduce((total, g) => total + Number(g.sum?.egressBytes ?? 0) + Number(g.sum?.ingressBytes ?? 0), 0);
  usage = { bytes, at: Date.now() };
  return bytes;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "X-MW-Auth",
};
const noStore = { ...cors, "Cache-Control": "no-store" };
