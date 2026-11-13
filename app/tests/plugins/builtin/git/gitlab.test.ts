import { describe, expect, it } from "vitest";
import { gitlabAccess, gitlabNotes, gitlabTags, publishGitlabRelease } from "../../../../src/plugins/builtin/git/gitlab";
import type { Attachment, UploadTarget } from "../../../../src/plugins/builtin/git/releases";

// GitLab's API in memory: answers by "METHOD url", records the calls (with JSON bodies) in order.
function gitlab(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { key: string; body: unknown; token: string | null }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : null, token: new Headers(init?.headers).get("PRIVATE-TOKEN") });
    const route = routes[key] ?? { status: 404, body: { message: "404 Project Not Found" } };
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls, keys: () => calls.map((c) => c.key) };
}

const api = "https://gitlab.example.com/api/v4/projects/team%2Fapp";
const fields = { tag: "v2.0.0", target: "main", name: "", body: "Notes", prerelease: false };

function file(name: string, sent: string[], fails = false): Attachment & { to: UploadTarget | null } {
  const f = {
    key: name, name, size: 10, to: null as UploadTarget | null,
    async upload(to: UploadTarget, onProgress: (n: number) => void) {
      f.to = to;
      sent.push(name);
      onProgress(0.5);
      if (fails) throw new Error(`Uploading ${name} failed (500)`);
    },
  };
  return f;
}

describe("GitLab releases", () => {
  it("lets tokens with the Developer role or higher create releases, in the project or through its group", async () => {
    type Level = { access_level: number } | null;
    const access = (permissions: { project_access: Level; group_access: Level }) => gitlabAccess("gitlab.example.com", "team/app", "t", gitlab({
      [`GET ${api}`]: { body: { permissions } },
      "GET https://gitlab.example.com/api/v4/user": { body: { id: 42 } },
      [`GET ${api}/members/all/42`]: { body: { access_level: permissions.project_access?.access_level ?? 0 } },
    }).fn);
    expect(await access({ project_access: { access_level: 30 }, group_access: null })).toBe(true);
    expect(await access({ project_access: null, group_access: { access_level: 40 } })).toBe(true);
    expect(await access({ project_access: { access_level: 20 }, group_access: null })).toBe(false);
  });

  it("counts a role inherited from a parent group, which the project's own permissions don't show", async () => {
    const inherited = (level: number | null) => gitlabAccess("gitlab.example.com", "team/app", "t", gitlab({
      [`GET ${api}`]: { body: { permissions: { project_access: null, group_access: null } } },
      "GET https://gitlab.example.com/api/v4/user": { body: { id: 42 } },
      [`GET ${api}/members/all/42`]: level === null ? { status: 404, body: { message: "404 Not found" } } : { body: { access_level: level } },
    }).fn);
    expect(await inherited(40)).toBe(true);
    expect(await inherited(20)).toBe(false);
    expect(await inherited(null)).toBe(false);
  });

  it("lists the project's tags with the token", async () => {
    const g = gitlab({ [`GET ${api}/repository/tags?per_page=100`]: { body: [{ name: "v1.9.0" }, { name: "v1.10.0" }] } });
    expect(await gitlabTags("gitlab.example.com", "team/app", "t", g.fn)).toEqual(["v1.9.0", "v1.10.0"]);
    expect(g.calls[0].token).toBe("t");
  });

  it("writes notes from the commits since the last version tag, or the branch's latest without one", async () => {
    const since = gitlab({
      [`GET ${api}/repository/tags?per_page=100`]: { body: [{ name: "v1.9.0" }, { name: "v1.10.0" }, { name: "nightly" }] },
      [`GET ${api}/repository/compare?from=v1.10.0&to=main`]: { body: { commits: [{ short_id: "a1b2c3d", title: "Add export" }, { short_id: "e4f5a6b", title: "Fix crash" }] } },
    });
    expect(await gitlabNotes("gitlab.example.com", "team/app", "t", "v2.0.0", "main", since.fn)).toBe("- Add export (a1b2c3d)\n- Fix crash (e4f5a6b)");
    const first = gitlab({
      [`GET ${api}/repository/tags?per_page=100`]: { body: [] },
      [`GET ${api}/repository/commits?ref_name=main&per_page=50`]: { body: [{ short_id: "0000001", title: "First" }] },
    });
    expect(await gitlabNotes("gitlab.example.com", "team/app", "t", "v1.0.0", "main", first.fn)).toBe("- First (0000001)");
  });

  it("puts every file in the package registry, then makes the release with links to them", async () => {
    const g = gitlab({ [`POST ${api}/releases`]: { status: 201, body: { _links: { self: "https://gitlab.example.com/team/app/-/releases/v2.0.0" } } } });
    const sent: string[] = [];
    const files = [file("app.AppImage", sent), file("MakeWork Setup 2.0.0.exe", sent)];
    const progress: string[] = [];
    const result = await publishGitlabRelease("gitlab.example.com", "team/app", "t", fields, files, (k, d) => progress.push(`${k}:${d}`), g.fn);
    const packageUrl = `${api}/packages/generic/app/v2.0.0/MakeWork_Setup_2.0.0.exe`;
    expect(files[1].to).toEqual({ method: "PUT", url: packageUrl, headers: { "PRIVATE-TOKEN": "t" } });
    expect(sent).toEqual(["app.AppImage", "MakeWork Setup 2.0.0.exe"]);
    expect(g.keys()).toEqual([`POST ${api}/releases`]);
    expect(g.calls[0].body).toEqual({
      tag_name: "v2.0.0", ref: "main", name: "v2.0.0", description: "Notes",
      assets: { links: [
        { name: "app.AppImage", url: `${api}/packages/generic/app/v2.0.0/app.AppImage`, link_type: "package" },
        { name: "MakeWork Setup 2.0.0.exe", url: packageUrl, link_type: "package" },
      ] },
    });
    expect(progress.at(-1)).toBe("MakeWork Setup 2.0.0.exe:1");
    expect(result).toEqual({ url: "https://gitlab.example.com/team/app/-/releases/v2.0.0" });
  });

  it("makes no release when a file fails, and says which", async () => {
    const g = gitlab({});
    const sent: string[] = [];
    const result = await publishGitlabRelease("gitlab.example.com", "team/app", "t", fields, [file("a.deb", sent), file("b.exe", sent, true), file("c.zip", sent)], () => {}, g.fn);
    expect(result.failed?.name).toBe("b.exe");
    expect(result.url).toBe("https://gitlab.example.com/team/app/-/releases");
    expect(sent).toEqual(["a.deb", "b.exe"]);
    expect(g.calls).toEqual([]);
  });

  it("explains refusals", async () => {
    const refuse = (status: number, body: unknown) =>
      publishGitlabRelease("gitlab.example.com", "team/app", "t", fields, [], () => {}, gitlab({ [`POST ${api}/releases`]: { status, body } }).fn);
    await expect(refuse(409, { message: "Release already exists" })).rejects.toThrow("That tag already has a release.");
    await expect(refuse(403, { message: "403 Forbidden" })).rejects.toThrow(/Developer role/);
    await expect(refuse(401, { message: "401 Unauthorized" })).rejects.toThrow("GitLab refused the token.");
    await expect(refuse(404, {})).rejects.toThrow("GitLab doesn't show this project to the token.");
    await expect(refuse(400, { message: "Tag name invalid" })).rejects.toThrow("GitLab didn't accept the release: Tag name invalid.");
  });
});
