// The folder on this device a version control channel works in, through the desktop app's git (electron/gitOps.js).
// Errors come back as plain messages; a remote that needs a sign-in comes back as a GitAuthError.
import { ShownError } from "../../../api/client";
import { account } from "../../../core/account";
import { desktop, desktopError, type DesktopBridge } from "../../../core/desktop";
import { connectionRevision, folderCredentials } from "./connections";
import { workingCopies, workingCopiesRevision } from "./data";

type LocalGit = NonNullable<DesktopBridge["git"]>;

// Fetch, pull or push couldn't sign in to `host` (gitOps.js marks these "[auth host]"). For github.com and
// gitlab.com only MakeWork's own sign-in is used, so the fix is signing in here.
export class GitAuthError extends ShownError {
  constructor(readonly host: string, message: string) {
    super(message);
  }
}

// Each working copy's connection for main, worked out again only after a connection, a pick or a linked folder
// changed (every git call sends it, and reading them all scans this device's storage).
let credentials: { version: string; value: Record<string, string> } | null = null;
function currentCredentials(): Record<string, string> {
  const version = `${account()?.id ?? ""}:${connectionRevision()}:${workingCopiesRevision()}`;
  if (credentials?.version !== version) credentials = { version, value: folderCredentials(workingCopies()) };
  return credentials.value;
}

export function gitCall<T>(action: (git: LocalGit) => Promise<T>): Promise<T> {
  const git = desktop?.git;
  if (!git) return Promise.reject(new Error("This needs the desktop app."));
  // Main signs network commands in with this account's host connections: each folder with its channel's.
  return git.useAccount(account()?.id ?? null, currentCredentials()).then(() => action(git)).catch((e) => {
    const error = desktopError(e);
    const auth = /^\[auth ([\w.-]+)\] ?/.exec(error.message);
    throw auth ? new GitAuthError(auth[1], error.message.slice(auth[0].length)) : error;
  });
}

// Commits as a short list line: "abc1234 Subject (Author)".
export const commitLine = (c: { sha: string; subject: string; author: string }) => `${c.sha.slice(0, 7)} ${c.subject} (${c.author})`;
