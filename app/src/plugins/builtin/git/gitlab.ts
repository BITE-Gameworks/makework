// GitLab releases (gitlab.com and self-hosted) through the REST API with the member's own token: who may make one,
// tags, notes, and publishing. GitLab has no drafts and keeps no files in a release, so every file goes to the
// project's generic package registry first, and the release is made, with links to them, only once all are there.
import { ShownError } from "../../../api/client";
import { latestTag, type ReleaseFields } from "./github";
import type { Attachment } from "./releases";

type Fetch = typeof fetch;

const api = (host: string, path: string) => `https://${host}/api/v4/projects/${encodeURIComponent(path)}`;

// `missing`: what a 404 means instead of an error (a lookup that may find nothing).
async function call<T>(fetchFn: Fetch, method: string, url: string, token: string, body?: unknown, missing?: { value: T }): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method,
      headers: { "PRIVATE-TOKEN": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ShownError("Couldn't reach GitLab.");
  }
  if (response.ok) return (await response.json()) as T;
  if (response.status === 404 && missing) return missing.value;
  let detail: { message?: unknown; error?: string } = {};
  try {
    detail = await response.json();
  } catch {
    // No body.
  }
  const message = typeof detail.message === "string" ? detail.message : detail.error ?? (detail.message ? JSON.stringify(detail.message) : "");
  if (response.status === 401) throw new ShownError("GitLab refused the token.");
  if (response.status === 403) throw new ShownError("The token can't change this project: it needs the api scope and the Developer role.");
  if (response.status === 404) throw new ShownError("GitLab doesn't show this project to the token.");
  if (response.status === 409) throw new ShownError("That tag already has a release.");
  if (response.status === 400 || response.status === 422) throw new ShownError(`GitLab didn't accept the release: ${message || response.status}.`);
  throw new ShownError(`GitLab answered ${response.status}${message ? `: ${message}` : ""}.`);
}

// Whether the token may create releases: the Developer role (30) or higher. The project's permissions show only
// direct membership (the project's or its own group's), so below that the user's membership with every parent
// group counted is asked for too (`members/all`; a 404 means none).
export async function gitlabAccess(host: string, path: string, token: string, fetchFn: Fetch = fetch): Promise<boolean> {
  type Access = { access_level?: number } | null;
  const project = await call<{ permissions?: { project_access?: Access; group_access?: Access } }>(fetchFn, "GET", api(host, path), token);
  const direct = Math.max(project.permissions?.project_access?.access_level ?? 0, project.permissions?.group_access?.access_level ?? 0);
  if (direct >= 30) return true;
  const me = await call<{ id: number }>(fetchFn, "GET", `https://${host}/api/v4/user`, token);
  const member = await call<{ access_level?: number } | null>(fetchFn, "GET", `${api(host, path)}/members/all/${me.id}`, token, undefined, { value: null });
  return (member?.access_level ?? 0) >= 30;
}

export async function gitlabTags(host: string, path: string, token: string, fetchFn: Fetch = fetch): Promise<string[]> {
  return (await call<{ name: string }[]>(fetchFn, "GET", `${api(host, path)}/repository/tags?per_page=100`, token)).map((t) => t.name);
}

// GitLab writes no notes for a new tag: the commits since the highest version tag (the branch's latest 50 without
// one), a line each.
export async function gitlabNotes(host: string, path: string, token: string, _tag: string, branch: string, fetchFn: Fetch = fetch): Promise<string> {
  const base = api(host, path);
  const previous = latestTag(await gitlabTags(host, path, token, fetchFn));
  type Commit = { short_id: string; title: string };
  const commits = previous
    ? (await call<{ commits: Commit[] }>(fetchFn, "GET", `${base}/repository/compare?from=${encodeURIComponent(previous)}&to=${encodeURIComponent(branch)}`, token)).commits
    : await call<Commit[]>(fetchFn, "GET", `${base}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=50`, token);
  return commits.map((c) => `- ${c.title} (${c.short_id})`).join("\n");
}

// Package names, versions and file names take letters, digits and . _ - only.
const safe = (text: string) => text.replace(/[^\w.-]+/g, "_");

// Every file into the package registry (under the project's name and the tag), then the release with a link to
// each. If a file fails nothing is released, and `failed` names it; `url` is the project's releases then.
export async function publishGitlabRelease(host: string, path: string, token: string, fields: ReleaseFields, files: Attachment[],
  onProgress: (key: string, done: number) => void, fetchFn: Fetch = fetch): Promise<{ url: string; failed?: { name: string; message: string } }> {
  const base = api(host, path);
  const packageBase = `${base}/packages/generic/${safe(path.split("/").at(-1)!)}/${safe(fields.tag)}`;
  const links: { name: string; url: string; link_type: "package" }[] = [];
  for (const file of files) {
    const url = `${packageBase}/${safe(file.name)}`;
    try {
      await file.upload({ method: "PUT", url, headers: { "PRIVATE-TOKEN": token } }, (done) => onProgress(file.key, done));
      onProgress(file.key, 1);
    } catch (e) {
      return { url: `https://${host}/${path}/-/releases`, failed: { name: file.name, message: e instanceof Error ? e.message : String(e) } };
    }
    links.push({ name: file.name, url, link_type: "package" });
  }
  const release = await call<{ _links?: { self?: string } }>(fetchFn, "POST", `${base}/releases`, token, {
    tag_name: fields.tag, ref: fields.target, name: fields.name || fields.tag, description: fields.body, assets: { links },
  });
  return { url: release._links?.self ?? `https://${host}/${path}/-/releases/${encodeURIComponent(fields.tag)}` };
}
