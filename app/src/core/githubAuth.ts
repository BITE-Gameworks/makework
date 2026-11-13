// MakeWork's own GitHub connection for repositories, so git never borrows another app's (VS Code's askpass, a
// credential manager, `gh`): the device flow in the desktop app (electron/main.js `github:*`) with the user server's
// GitHub app. The user enters a short code on github.com; the token is kept like a pasted one (core/secrets.ts,
// host "github.com"), so imports, releases and fetch/pull/push all use it.
import { createSignal } from "solid-js";
import { account } from "./account";
import { desktop, desktopError } from "./desktop";
import { forgetToken, getToken } from "./secrets";
import { serverFeatures } from "./userServer";

export type DeviceResult = Awaited<ReturnType<NonNullable<NonNullable<typeof desktop>["github"]>["deviceWait"]>>;

export interface DeviceSignIn {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  done: Promise<DeviceResult>;
  cancel(): void;
}

// Changes after every sign-in and sign-out, so views showing the GitHub login read it again.
const [revision, setRevision] = createSignal(0);
export const githubRevision = revision;

// Whether MakeWork's own GitHub device flow can actually run here: the desktop app and a client id (from the build
// or the user server). Checked once; views read the signal (null until checked).
const [deviceReady, setDeviceReady] = createSignal<boolean | null>(null);
export const githubSignInReady = deviceReady;
let deviceChecked = false;

export async function checkGitHubSignIn(): Promise<void> {
  if (!desktop?.github) {
    setDeviceReady(false);
    return;
  }
  if (deviceChecked) return;
  deviceChecked = true;
  if (import.meta.env.VITE_GITHUB_CLIENT_ID) {
    setDeviceReady(true);
    return;
  }
  try {
    setDeviceReady(!!(await serverFeatures()).githubClientId);
  } catch {
    setDeviceReady(false);
  }
}

async function clientId(): Promise<string> {
  const own = import.meta.env.VITE_GITHUB_CLIENT_ID;
  if (own) return own;
  const { githubClientId } = await serverFeatures();
  if (!githubClientId) throw new Error("Your user server has no GitHub app set up, so MakeWork can't sign in to GitHub. A token works instead.");
  return githubClientId;
}

// Starts a sign-in: GitHub's page opens in the browser, the code is shown in the app until the user approved there.
export async function startGitHubSignIn(): Promise<DeviceSignIn> {
  const github = desktop?.github;
  const id = account()?.id;
  if (!github) throw new Error("Signing in to GitHub needs the desktop app.");
  if (!id) throw new Error("Sign in to MakeWork first.");
  try {
    const started = await github.deviceStart(await clientId(), id);
    const done = github.deviceWait(started.handle).then((result) => {
      if (result.ok) setRevision((n) => n + 1);
      return result;
    });
    return {
      userCode: started.userCode, verificationUri: started.verificationUri, expiresAt: Date.now() + started.expiresIn * 1000, done,
      cancel: () => void github.deviceCancel(started.handle),
    };
  } catch (e) {
    throw desktopError(e);
  }
}

export const openGitHubDevicePage = () => void desktop?.github?.openDevicePage();

// The GitHub user the kept token belongs to; null without one (or when GitHub doesn't accept it any more).
export async function githubLogin(): Promise<string | null> {
  const token = await getToken("github.com");
  if (!token) return null;
  const res = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } })
    .catch(() => null);
  if (!res?.ok) return null;
  const user = (await res.json().catch(() => ({}))) as { login?: string };
  return user.login ?? null;
}

export async function signOutOfGitHub(): Promise<void> {
  await forgetToken("github.com");
  setRevision((n) => n + 1);
}
