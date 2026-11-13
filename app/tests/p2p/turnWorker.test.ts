// The TURN worker (../turn-worker) with Cloudflare's APIs stubbed: credentials only for signed requests of user
// server accounts, a few per hour.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, exportPkcs8, importPrivateKey } from "../../src/core/identity";
import { authHeader, type Signer } from "../../src/core/userServer";
// @ts-expect-error plain JS worker without types
import turn from "../../../turn-worker/worker.js";
import { userDatabase } from "../d1";

const url = "https://turn.test/";
let env: Record<string, unknown>;
let issued = 0;

async function account(db: ReturnType<typeof userDatabase>): Promise<Signer> {
  const identity = await createIdentity(true);
  const key = await importPrivateKey(await exportPkcs8(identity.privateKey), false);
  await db.prepare("INSERT INTO accounts (id, username, public_key, profile, created_at, updated_at) VALUES (?, ?, ?, '{}', 0, 0)")
    .bind(identity.id, identity.id.toLowerCase().replace(/[^a-z]/g, "").slice(0, 8), JSON.stringify({ x: identity.publicKey.x, y: identity.publicKey.y })).run();
  return { id: identity.id, key };
}

async function ask(signer?: Signer, ip = "1.2.3.4") {
  const headers: Record<string, string> = { "CF-Connecting-IP": ip };
  if (signer) headers["X-MW-Auth"] = await authHeader(signer, "GET", new URL(url));
  const response: Response = await turn.fetch(new Request(url, { headers }), env);
  return { status: response.status, body: await response.json() as { iceServers: unknown[]; ttl: number; reason?: string } };
}

beforeEach(() => {
  issued = 0;
  env = { DB: userDatabase(), TURN_KEY_ID: "k", TURN_KEY_API_TOKEN: "t", ANALYTICS_API_TOKEN: "a", ACCOUNT_ID: "c", CAP_GB: "500", PER_ACCOUNT_HOUR: "2", PER_IP_HOUR: "3" };
  vi.stubGlobal("fetch", async (target: string) => {
    if (target.includes("graphql"))
      return Response.json({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: 1, ingressBytes: 1 } }] }] } } });
    issued++;
    return Response.json({ iceServers: [{ urls: ["turn:turn.test:3478"], username: "u", credential: "c" }] });
  });
});

describe("TURN worker", () => {
  it("counts requests sent all at once against the hourly limit", async () => {
    const ada = await account(env.DB as ReturnType<typeof userDatabase>);
    // Cloudflare takes a moment, so all six are past their checks before any is answered.
    vi.stubGlobal("fetch", async (target: string) => {
      if (target.includes("graphql"))
        return Response.json({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      issued++;
      return Response.json({ iceServers: [{ urls: ["turn:turn.test:3478"], username: "u", credential: "c" }] });
    });
    const answers = await Promise.all(Array.from({ length: 6 }, () => ask(ada)));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(2);
    expect(issued).toBe(2);
  });

  it("answers in JSON when Cloudflare's reply has no servers", async () => {
    const ada = await account(env.DB as ReturnType<typeof userDatabase>);
    vi.stubGlobal("fetch", async (target: string) => target.includes("graphql")
      ? Response.json({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } } })
      : Response.json({ unexpected: true }));
    const answer = await ask(ada);
    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({ iceServers: [] });
    // A failed grant isn't counted.
    expect((await ask(ada)).status).toBe(502);
    expect((await ask(ada)).status).toBe(502);
  });

  it("doesn't count a grant when Cloudflare can't be reached", async () => {
    const ada = await account(env.DB as ReturnType<typeof userDatabase>);
    vi.stubGlobal("fetch", async (target: string) => {
      if (target.includes("graphql")) return Response.json({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } } });
      throw new TypeError("fetch failed");
    });
    for (let i = 0; i < 3; i++) expect((await ask(ada)).status).toBe(502);
  });

  it("gives 30 minute credentials only to signed requests of known accounts, a few per hour", async () => {
    const db = env.DB as ReturnType<typeof userDatabase>;
    const ada = await account(db);
    const bob = await account(db);

    expect((await ask()).status).toBe(401);
    const stranger = await createIdentity(false);
    expect((await ask({ id: stranger.id, key: stranger.privateKey })).status).toBe(401);

    const first = await ask(ada);
    expect(first.body).toMatchObject({ ttl: 1800 });
    expect(first.body.iceServers).toHaveLength(1);
    expect((await ask(ada)).status).toBe(200);
    expect((await ask(ada)).body.reason).toBe("too many requests");
    // Per address too.
    expect((await ask(bob)).status).toBe(200);
    expect((await ask(bob)).status).toBe(429);
    expect((await ask(bob, "5.6.7.8")).status).toBe(200);
    expect(issued).toBe(4);
  });
});
