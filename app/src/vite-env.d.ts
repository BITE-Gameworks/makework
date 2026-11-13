/// <reference types="vite/client" />

// app/package.json's "version", filled in at build time (core/version.ts).
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  // Google OAuth clients (see .env.example).
  readonly VITE_GOOGLE_WEB_CLIENT_ID?: string;
  readonly VITE_GOOGLE_DESKTOP_CLIENT_ID?: string;
  readonly VITE_GOOGLE_DESKTOP_CLIENT_SECRET?: string;
  // Worker that hands out TURN credentials (turn-worker/), instead of the built-in one.
  readonly VITE_TURN_URL?: string;
  // User server (user-server/) used until the user picks another in settings.
  readonly VITE_USER_SERVER_URL?: string;
  // GitHub OAuth app for signing in to repositories, instead of the user server's (src/core/githubAuth.ts).
  readonly VITE_GITHUB_CLIENT_ID?: string;
}
