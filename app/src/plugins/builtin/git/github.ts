// GitHub releases through the REST API with the member's own token (what actions/create-release does inside a
// workflow): who may make one, tags, generated notes, and publishing a release with its files. A release is
// created as a draft first and only published once every file is uploaded, so nobody sees it half finished.
import { ShownError } from "../../../api/client";
import type { Attachment, UploadTarget } from "./releases";

type Fetch = typeof fetch;

export interface Release {
  id: number;
  html_url: string;
  upload_url: string;
}

export interface ReleaseFields {
  tag: string;
  target: string;
  name: string;
  body: string;
  prerelease: boolean;
}

const api = (path: string) => `https://api.github.com/repos/${path}`;

async function call<T>(fetchFn: Fetch, method: string, url: string, token: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ShownError("Couldn't reach GitHub.");
  }
  if (response.ok) return (await response.json()) as T;
  let detail: { message?: string; errors?: { code?: string; field?: string; message?: string }[] } = {};
  try {
    detail = await response.json();
  } catch {
    // No body.
  }
  if (response.status === 401) throw new ShownError("GitHub refused the token.");
  if (response.status === 403) throw new ShownError("The token can't change this repository: it needs \"Contents: read and write\".");
  if (response.status === 404) throw new ShownError("GitHub doesn't show this repository to the token.");
  if (response.status === 422) {
    if (detail.errors?.some((e) => e.code === "already_exists")) throw new ShownError("That tag already has a release.");
    throw new ShownError(`GitHub didn't accept the release: ${detail.errors?.map((e) => e.message ?? e.code).join(", ") || detail.message}.`);
  }
  throw new ShownError(`GitHub answered ${response.status}${detail.message ? `: ${detail.message}` : ""}.`);
}

// Whether the token may create releases (push access or more).
export async function repoAccess(path: string, token: string, fetchFn: Fetch = fetch): Promise<boolean> {
  const repo = await call<{ permissions?: { push?: boolean; maintain?: boolean; admin?: boolean } }>(fetchFn, "GET", api(path), token);
  return !!(repo.permissions?.push || repo.permissions?.maintain || repo.permissions?.admin);
}

export async function listTags(path: string, token: string, fetchFn: Fetch = fetch): Promise<string[]> {
  return (await call<{ name: string }[]>(fetchFn, "GET", `${api(path)}/tags?per_page=100`, token)).map((t) => t.name);
}

// The highest numbered tag (v1.10.0 over v1.9.9; "nightly" isn't a version), split into its parts; null without one.
function latestVersion(tags: string[]): { tag: string; prefix: string; parts: number[] } | null {
  const versions = tags.flatMap((tag) => {
    const match = /^(v?)(\d+(?:\.\d+)*)$/.exec(tag);
    return match ? [{ tag, prefix: match[1], parts: match[2].split(".").map(Number) }] : [];
  });
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  return versions.toSorted((a, b) => compare(b.parts, a.parts))[0] ?? null;
}

export const latestTag = (tags: string[]): string | null => latestVersion(tags)?.tag ?? null;

// The next version after the highest numbered tag: v1.4.2 -> v1.4.3, 1.9 -> 1.10; v1.0.0 without one.
export function nextTag(tags: string[]): string {
  const latest = latestVersion(tags);
  if (!latest) return "v1.0.0";
  const parts = [...latest.parts];
  parts[parts.length - 1]++;
  return `${latest.prefix}${parts.join(".")}`;
}

// GitHub's changelog for a new tag: the pull requests and contributors since the previous release.
export async function generateNotes(path: string, token: string, tag: string, target: string, fetchFn: Fetch = fetch): Promise<string> {
  return (await call<{ body: string }>(fetchFn, "POST", `${api(path)}/releases/generate-notes`, token, { tag_name: tag, target_commitish: target })).body;
}

// A file's upload into the draft: its upload_url ("https://uploads.github.com/…/assets{?name,label}") with the name.
function uploadTarget(release: Release, token: string, name: string): UploadTarget {
  const url = new URL(release.upload_url.split("{")[0]);
  url.searchParams.set("name", name);
  return { method: "POST", url: url.toString(), headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } };
}

// Draft, then every file, then published (unless it should stay a draft). If a file fails, the draft is kept and
// the error names the file; `release` is returned either way so the page can link to it.
export async function publishRelease(path: string, token: string, fields: ReleaseFields, files: Attachment[], keepDraft: boolean,
  onProgress: (key: string, done: number) => void, fetchFn: Fetch = fetch): Promise<{ release: Release; failed?: { name: string; message: string } }> {
  const release = await call<Release>(fetchFn, "POST", `${api(path)}/releases`, token, {
    tag_name: fields.tag, target_commitish: fields.target, name: fields.name || fields.tag, body: fields.body,
    draft: true, prerelease: fields.prerelease,
  });
  for (const file of files) {
    try {
      await file.upload(uploadTarget(release, token, file.name), (done) => onProgress(file.key, done));
      onProgress(file.key, 1);
    } catch (e) {
      return { release, failed: { name: file.name, message: e instanceof Error ? e.message : String(e) } };
    }
  }
  if (keepDraft) return { release };
  return { release: await call<Release>(fetchFn, "PATCH", `${api(path)}/releases/${release.id}`, token, { draft: false }) };
}

// In a browser: a picked File straight to its upload target, on either host.
export async function uploadFile(to: UploadTarget, file: File, fetchFn: Fetch = fetch): Promise<void> {
  const response = await fetchFn(to.url, {
    method: to.method, body: file, headers: { ...to.headers, "Content-Type": file.type || "application/octet-stream" },
  }).catch(() => null);
  if (!response?.ok) throw new ShownError(`Uploading ${file.name} failed${response ? ` (${response.status})` : ": the host couldn't be reached from the browser, use the desktop app"}.`);
}
