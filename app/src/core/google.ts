// Sign in with Google (OpenID Connect). The browser build opens Google in a popup (implicit flow, ID token in
// the redirect); the desktop shell opens the system browser with a loopback redirect, since Google blocks
// sign-in inside embedded windows. Either way we get Google's ID token straight from Google over TLS, and an access
// token for the app's hidden Drive folder, where the account key is kept (core/drive.ts).
import { desktop } from "./desktop";
import { base64url, jwtClaims } from "./identity";

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture: string;
  idToken: string;
  accessToken: string;
}

// MakeWork's OAuth clients. Client IDs are public. The desktop client's secret comes in at build time
// (VITE_GOOGLE_DESKTOP_CLIENT_SECRET: `.env.local`, or the release workflow's secret) and stays out of the source;
// Google doesn't treat an installed app's secret as confidential, since every copy of the app carries it. Without it
// the desktop app offers no Google sign-in. `.env.local` can also point at other clients.
const env = import.meta.env;
const webClientId = env.VITE_GOOGLE_WEB_CLIENT_ID || "50887485708-au7vo1cff6dkqvcmpin5k0v694unpcm2.apps.googleusercontent.com";
const desktopClient = {
  id: env.VITE_GOOGLE_DESKTOP_CLIENT_ID || "50887485708-0au30jlbdjep3tf8bjg66f0dldvc9tb6.apps.googleusercontent.com",
  secret: env.VITE_GOOGLE_DESKTOP_CLIENT_SECRET || "",
};
const issuers = new Set(["https://accounts.google.com", "accounts.google.com"]);
export const callbackChannel = "makework-google";
const scope = "openid email profile https://www.googleapis.com/auth/drive.appdata";

export function googleAvailable(): boolean {
  return desktop?.googleSignIn ? desktopClient.id !== "" && desktopClient.secret !== "" : webClientId !== "";
}

// `loginHint` (an email) makes Google use that account, or ask to sign in to it, instead of one it picks.
export async function signInWithGoogle(loginHint?: string): Promise<GoogleProfile> {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  if (desktop?.googleSignIn) {
    const { idToken, accessToken } = await desktop.googleSignIn({
      clientId: desktopClient.id, clientSecret: desktopClient.secret, nonce, scope, ...(loginHint && { loginHint }),
    });
    return profile(idToken, accessToken, desktopClient.id, nonce);
  }
  const { idToken, accessToken } = await popup(nonce, loginHint);
  return profile(idToken, accessToken, webClientId, nonce);
}

function popup(nonce: string, loginHint?: string): Promise<{ idToken: string; accessToken: string }> {
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: webClientId,
    redirect_uri: `${location.origin}/google-callback.html`,
    response_type: "id_token token",
    scope,
    prompt: "select_account",
    nonce, state,
    ...(loginHint && { login_hint: loginHint }),
  }).toString();

  const win = window.open(url, "makework-google", "popup,width=480,height=640");
  if (!win) return Promise.reject(new Error("The sign-in popup was blocked."));

  // Google's pages cut window.opener, so the callback page answers on a BroadcastChannel instead.
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(callbackChannel);
    const done = () => {
      channel.close();
      clearInterval(closedCheck);
    };
    channel.onmessage = (event: MessageEvent<{ hash: string }>) => {
      const params = new URLSearchParams(event.data.hash.replace(/^#/, ""));
      if (params.get("state") !== state) return;
      done();
      const idToken = params.get("id_token");
      const accessToken = params.get("access_token");
      if (idToken && accessToken) resolve({ idToken, accessToken });
      else reject(new Error(params.get("error") === "access_denied" ? "Sign-in was cancelled." : `Google said: ${params.get("error")}`));
    };
    const closedCheck = setInterval(() => {
      if (win.closed) {
        done();
        reject(new Error("Sign-in was cancelled."));
      }
    }, 500);
  });
}

function profile(idToken: string, accessToken: string, clientId: string, nonce: string): GoogleProfile {
  const claims = jwtClaims(idToken);
  if (claims.aud !== clientId || !issuers.has(String(claims.iss)) || claims.nonce !== nonce)
    throw new Error("Google's answer was not meant for this app.");
  if (Number(claims.exp) * 1000 < Date.now()) throw new Error("Google's answer has expired.");
  return {
    sub: String(claims.sub),
    email: String(claims.email ?? ""),
    name: String(claims.name ?? claims.email ?? ""),
    picture: String(claims.picture ?? ""),
    idToken,
    accessToken,
  };
}
