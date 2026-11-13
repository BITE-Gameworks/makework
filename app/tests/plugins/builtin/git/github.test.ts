import { describe, expect, it } from "vitest";
import { nextTag, publishRelease, repoAccess } from "../../../../src/plugins/builtin/git/github";
import type { Attachment, UploadTarget } from "../../../../src/plugins/builtin/git/releases";

// GitHub's API in memory: answers by "METHOD url", records the calls in order.
function github(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    const route = routes[key] ?? { status: 404, body: { message: "Not Found" } };
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const api = "https://api.github.com/repos/o/r";
const draft = { id: 7, html_url: "https://github.com/o/r/releases/tag/v1.0.1", upload_url: "https://uploads.github.com/repos/o/r/releases/7/assets{?name,label}" };
const fields = { tag: "v1.0.1", target: "main", name: "", body: "Notes", prerelease: false };

function file(name: string, fails = false): Attachment & { uploaded: boolean; to: UploadTarget | null } {
  const f = {
    key: name, name, size: 10, uploaded: false, to: null as UploadTarget | null,
    async upload(to: UploadTarget, onProgress: (n: number) => void) {
      f.to = to;
      onProgress(0.5);
      if (fails) throw new Error(`Uploading ${name} failed (500)`);
      f.uploaded = true;
    },
  };
  return f;
}

describe("GitHub releases", () => {
  it("lets tokens that can push create releases", async () => {
    expect(await repoAccess("o/r", "t", github({ [`GET ${api}`]: { body: { permissions: { push: true } } } }).fn)).toBe(true);
    expect(await repoAccess("o/r", "t", github({ [`GET ${api}`]: { body: { permissions: { pull: true } } } }).fn)).toBe(false);
  });

  it("suggests the next tag after the highest version", () => {
    expect(nextTag(["v1.4.2", "v1.10.0", "v1.9.9", "nightly"])).toBe("v1.10.1");
    expect(nextTag(["1.9"])).toBe("1.10");
    expect(nextTag([])).toBe("v1.0.0");
  });

  it("creates a draft, uploads every file, then publishes", async () => {
    const g = github({ [`POST ${api}/releases`]: { status: 201, body: draft }, [`PATCH ${api}/releases/7`]: { body: { ...draft } } });
    const files = [file("app.AppImage"), file("setup.exe")];
    const progress: string[] = [];
    const { release, failed } = await publishRelease("o/r", "t", fields, files, false, (k, d) => progress.push(`${k}:${d}`), g.fn);
    expect(g.calls).toEqual([`POST ${api}/releases`, `PATCH ${api}/releases/7`]);
    expect(files.every((f) => f.uploaded)).toBe(true);
    expect(files[1].to).toEqual({
      method: "POST", url: "https://uploads.github.com/repos/o/r/releases/7/assets?name=setup.exe",
      headers: { Authorization: "Bearer t", Accept: "application/vnd.github+json" },
    });
    expect(progress).toEqual(["app.AppImage:0.5", "app.AppImage:1", "setup.exe:0.5", "setup.exe:1"]);
    expect(release.html_url).toBe(draft.html_url);
    expect(failed).toBeUndefined();
  });

  it("keeps the draft when a file fails, and says which", async () => {
    const g = github({ [`POST ${api}/releases`]: { status: 201, body: draft } });
    const { failed } = await publishRelease("o/r", "t", fields, [file("a.deb"), file("b.exe", true), file("c.zip")], false, () => {}, g.fn);
    expect(failed?.name).toBe("b.exe");
    expect(g.calls).toEqual([`POST ${api}/releases`]);
  });

  it("explains refusals", async () => {
    const refuse = (status: number, body: unknown) => publishRelease("o/r", "t", fields, [], false, () => {}, github({ [`POST ${api}/releases`]: { status, body } }).fn);
    await expect(refuse(422, { message: "Validation Failed", errors: [{ code: "already_exists", field: "tag_name" }] })).rejects.toThrow("That tag already has a release.");
    await expect(refuse(403, {})).rejects.toThrow(/Contents: read and write/);
    await expect(refuse(401, {})).rejects.toThrow("GitHub refused the token.");
  });
});
