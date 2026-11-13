// Releases on the repository's host, GitHub or GitLab, through the member's host connection (their token for that
// host on this computer): only a connection that may write to the repository can make one, and without one the
// view offers no release at all.
import type { Repo } from "./data";
import { generateNotes, listTags, publishRelease, repoAccess, type ReleaseFields } from "./github";
import { gitlabAccess, gitlabNotes, gitlabTags, publishGitlabRelease } from "./gitlab";
import { parseRepoLink } from "./providers";

export interface ReleaseTarget { kind: "github" | "gitlab"; host: string; path: string }

// Where one release file goes and how: GitHub takes it into the release, GitLab into the project's package registry.
export interface UploadTarget { method: "POST" | "PUT"; url: string; headers: Record<string, string> }

// A release file on its way: from disk through the desktop app, or a File picked in a browser.
export interface Attachment {
  key: string;
  name: string;
  size: number;
  // Sends it, reporting progress 0..1.
  upload(to: UploadTarget, onProgress: (done: number) => void): Promise<void>;
}

// Where the repository's releases go: its own GitHub or GitLab, or for a folder on this computer its origin there.
export function releaseTarget(repo: Repo): ReleaseTarget | null {
  if (repo.provider === "github" || repo.provider === "gitlab") return { kind: repo.provider, host: repo.host, path: repo.path };
  const origin = parseRepoLink(repo.url);
  return origin?.provider ? { kind: origin.provider, host: origin.host, path: origin.path } : null;
}

// What the release page does on one host. `failed` is the message for a file that didn't go up.
export interface ReleaseHost {
  target: ReleaseTarget;
  name: "GitHub" | "GitLab";
  drafts: boolean;
  prereleases: boolean;
  // How publishing goes, under the Publish button.
  hint: string;
  access(token: string): Promise<boolean>;
  listTags(token: string): Promise<string[]>;
  generateNotes(token: string, tag: string, branch: string): Promise<string>;
  publish(token: string, fields: ReleaseFields, files: Attachment[], keepDraft: boolean, onProgress: (key: string, done: number) => void):
    Promise<{ url: string; failed?: string }>;
}

export function releaseHost(target: ReleaseTarget): ReleaseHost {
  const { host, path } = target;
  if (target.kind === "github") return {
    target, name: "GitHub", drafts: true, prereleases: true, hint: "Created as a draft first; published once every file is uploaded.",
    access: (token) => repoAccess(path, token),
    listTags: (token) => listTags(path, token),
    generateNotes: (token, tag, branch) => generateNotes(path, token, tag, branch),
    async publish(token, fields, files, keepDraft, onProgress) {
      const { release, failed } = await publishRelease(path, token, fields, files, keepDraft, onProgress);
      return { url: release.html_url, failed: failed && `${failed.message} The release was kept as a draft.` };
    },
  };
  return {
    target, name: "GitLab", drafts: false, prereleases: false,
    hint: "Files go to the project's package registry first; the release is made once every one is there.",
    access: (token) => gitlabAccess(host, path, token),
    listTags: (token) => gitlabTags(host, path, token),
    generateNotes: (token, tag, branch) => gitlabNotes(host, path, token, tag, branch),
    async publish(token, fields, files, _keepDraft, onProgress) {
      const { url, failed } = await publishGitlabRelease(host, path, token, fields, files, onProgress);
      return { url, failed: failed && `${failed.message} Nothing was released; the files sent before it stay in the package registry.` };
    },
  };
}
