// Why GitHub refuses a repository to a token. Git over HTTPS only ever says "Repository not found"; GitHub's REST API
// says what is in the way, so the view can tell the member what to do about it.
type Fetch = typeof fetch;

export type Refusal =
  // The organization lets only apps it approved read its private repositories (OAuth App access restrictions), or
  // wants the token authorized for its single sign-on (SAML): both are granted on GitHub's page for the app.
  | { kind: "restricted"; organization: string; sso: boolean }
  // The token can't see the repository: its account has no access, or a fine-grained token was made for another owner.
  | { kind: "noAccess"; login: string | null }
  // The token was revoked or ran out.
  | { kind: "signedOut" }
  // The token can read the repository but GitHub refused a write: a read-only fine-grained token, or one the
  // organization hasn't approved yet (that reaches public repositories only, read-only).
  | { kind: "readOnly" };

const headers = (token: string) => ({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${token}` });

// `path`: owner/repo. Null when the token can read it after all, or GitHub can't be asked.
export async function whyRefused(token: string, path: string, fetchFn: Fetch = fetch): Promise<Refusal | null> {
  const answer = await askGitHub(token, path, fetchFn);
  return answer === "readable" ? null : answer;
}

// For a refused push: a token that can read the repository can't write to it. Null when GitHub can't be asked.
export async function whyWriteRefused(token: string, path: string, fetchFn: Fetch = fetch): Promise<Refusal | null> {
  const answer = await askGitHub(token, path, fetchFn);
  return answer === "readable" ? { kind: "readOnly" } : answer;
}

async function askGitHub(token: string, path: string, fetchFn: Fetch): Promise<Refusal | "readable" | null> {
  let response: Response;
  try {
    response = await fetchFn(`https://api.github.com/repos/${path}`, { headers: headers(token) });
  } catch {
    return null;
  }
  if (response.ok) return "readable";
  if (response.status === 401) return { kind: "signedOut" };
  const { message = "" } = (await response.json().catch(() => ({}))) as { message?: string };
  const owner = path.split("/")[0];
  if (response.status === 403 && /OAuth App access restrictions/i.test(message))
    return { kind: "restricted", organization: /`([^`]+)` organization/.exec(message)?.[1] ?? owner, sso: false };
  if (response.status === 403 && /SAML/i.test(message)) return { kind: "restricted", organization: owner, sso: true };
  if (response.status !== 404 && response.status !== 403) return null;
  const user = await fetchFn("https://api.github.com/user", { headers: headers(token) })
    .then((r) => (r.ok ? (r.json() as Promise<{ login?: string }>) : null), () => null);
  return { kind: "noAccess", login: user?.login ?? null };
}

// GitHub's page for an OAuth app the member authorized: each organization is listed with Grant (owners) or Request.
export const appAccessPage = (clientId: string) => `https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}`;

// The refusal in a sentence or two.
export function describeRefusal(refusal: Refusal, path: string): string {
  if (refusal.kind === "signedOut") return "MakeWork's sign-in to GitHub has run out or was revoked. Sign in again.";
  if (refusal.kind === "noAccess")
    return `This connection${refusal.login ? ` (GitHub account ${refusal.login})` : ""} can't see ${path}: a fine-grained token reaches only the`
      + " repositories it was made for. Use a connection that can.";
  if (refusal.kind === "readOnly")
    return `This connection can read ${path} but GitHub refused the push. A fine-grained token needs "Contents: Read and write" (and`
      + ` "Workflows" to change workflow files), and an organization that approves tokens must approve it first.`;
  return refusal.sso
    ? `${refusal.organization} signs in through its single sign-on: authorize MakeWork for ${refusal.organization} on GitHub, then try again.`
    : `${refusal.organization} only lets apps it approved read its private repositories. Ask an owner to approve MakeWork, or request it on GitHub, then try again.`;
}
