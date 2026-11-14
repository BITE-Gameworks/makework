import { describe, expect, it } from "vitest";
import { appAccessPage, describeRefusal, whyRefused } from "../../../../src/plugins/builtin/git/githubAccess";

// GitHub's answers by URL, and what was asked with which token.
function github(routes: Record<string, { status: number; body?: unknown }>) {
  const asked: string[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push(`${String(url)} ${((init?.headers ?? {}) as Record<string, string>).Authorization}`);
    const route = routes[String(url)] ?? { status: 404, body: { message: "Not Found" } };
    return Response.json(route.body ?? {}, { status: route.status });
  }) as typeof fetch;
  return { fn, asked };
}

const repo = "https://api.github.com/repos/BITE-Gameworks/makework.dev";

describe("why GitHub refuses a repository", () => {
  it("names an organization's OAuth app restrictions", async () => {
    const { fn, asked } = github({ [repo]: { status: 403, body: { message:
      "Although you appear to have the correct authorization credentials, the `BITE-Gameworks` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited." } } });
    const refusal = await whyRefused("gho_token", "BITE-Gameworks/makework.dev", fn);
    expect(refusal).toEqual({ kind: "restricted", organization: "BITE-Gameworks", sso: false });
    expect(asked).toEqual([`${repo} Bearer gho_token`]);
    expect(describeRefusal(refusal!, "BITE-Gameworks/makework.dev")).toMatch(/^BITE-Gameworks only lets apps it approved/);
    expect(appAccessPage("Iv1.abc")).toBe("https://github.com/settings/connections/applications/Iv1.abc");
  });

  it("names single sign-on, an account that can't see it, and a sign-in that ran out", async () => {
    const sso = github({ [repo]: { status: 403, body: { message: "Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization." } } });
    expect(await whyRefused("t", "BITE-Gameworks/makework.dev", sso.fn)).toEqual({ kind: "restricted", organization: "BITE-Gameworks", sso: true });

    const hidden = github({ "https://api.github.com/user": { status: 200, body: { login: "octocat" } } });
    const refusal = await whyRefused("t", "BITE-Gameworks/makework.dev", hidden.fn);
    expect(refusal).toEqual({ kind: "noAccess", login: "octocat" });
    expect(describeRefusal(refusal!, "BITE-Gameworks/makework.dev")).toBe("The GitHub account octocat can't see BITE-Gameworks/makework.dev. Use a connection for an account that can.");

    expect(await whyRefused("t", "BITE-Gameworks/makework.dev", github({ [repo]: { status: 401 } }).fn)).toEqual({ kind: "signedOut" });
  });

  it("finds nothing in the way when the token can read it, or GitHub can't be asked", async () => {
    expect(await whyRefused("t", "BITE-Gameworks/makework.dev", github({ [repo]: { status: 200, body: { id: 1 } } }).fn)).toBeNull();
    expect(await whyRefused("t", "BITE-Gameworks/makework.dev", (async () => { throw new TypeError("offline"); }) as typeof fetch)).toBeNull();
    expect(await whyRefused("t", "BITE-Gameworks/makework.dev", github({ [repo]: { status: 500 } }).fn)).toBeNull();
  });
});
