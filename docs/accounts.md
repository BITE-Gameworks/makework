# Accounts, sign-in and the user server

## Accounts

An account is an ECDSA P-256 key pair made on the user's computer (`core/identity.ts`); its id is the first 16 bytes of
the SHA-256 of the public key, and its tag (`ada·4f2a`) the first two bytes of the id. Usernames are display names
anyone may share. Inside a workspace a member's user id is `userNumber(account)` (the first 6 bytes of the account id),
the same in every workspace.

Accounts live on each computer (IndexedDB, keys stored non-extractable) and are published to a **user server**
(`core/userServer.ts`, `user-server/`), which lets people find each other, keeps private messages for offline
recipients, and keeps password accounts' locked keys so they can sign in elsewhere. Which user server the app uses is a
setting; MakeWork's own is `me.makework.dev`.

Ways to sign in (`core/account.ts`, `shell/Auth.tsx`):

- **Email and password.** The private key is locked with the password on the computer (PBKDF2 + AES-GCM) and the
  locked copy is published with a verifier derived from the password with its own salt. The password never leaves
  the computer, and the user server can't unlock the key.
- **Google.** The key and profile live in the Google account's Drive app folder (`core/drive.ts`, scope
  `drive.appdata`), so every computer signing in with that Google account gets the same account. Electron opens
  Google in the system browser (Google blocks embedded windows); the browser and desktop builds use separate OAuth
  clients.
- **GitHub.** Runs through the user server, which holds the GitHub app's secret. The key then comes back like after a
  password reset (below).
- **Offline accounts** stay on one computer and can be exported as an account file.

Once an account is on a computer, later sign-ins there are local: the server isn't asked.

## Second step (2FA)

A password sign-in on a computer that doesn't hold the account needs a second step before the user server hands out
the locked key (decision 0027):

- **Authenticator app (TOTP).** Turned on in Settings > Account > Authenticator app: the server makes a secret (shown as
  a QR code and as text), a code from the app confirms it, and the owner gets ten one-time backup codes, shown once.
  Codes are 6 digits, 30 s steps, one step of clock drift either way, and each step is accepted once. Turning it off
  takes a code or a backup code.
- **Email code.** Without an authenticator app, the right password gets a 6-digit code mailed to the account's email
  (15 minutes, 5 guesses, 5 codes an hour). A wrong password sends nothing.

With an authenticator app on, the recovery copy (below) also needs one of its codes. Google and GitHub sign-ins are left
to those providers' own protection.

Server side: `login`, `checkTotp`, `confirmSignIn` and the `/me/totp/*` routes in `user-server/worker.js`; the answer to
a sign-in that needs a step is 403 with `needsTotp` or `needsCode`, which the app reads as `UserServerError.needs`.

## Forgotten passwords and recovery

A reset starts with a code mailed to the account's email. The key then comes back one of these ways:

- the **recovery copy** on the user server (the key encrypted with the server's `RECOVERY_SECRET`): off unless the
  owner turns it on, because whoever runs the server could read it (decision 0026);
- the **recovery key** the owner saved (its locked copy is kept on the server, which can't open it);
- **another computer still signed in**, which approves the request and hands the key over sealed to the new device.

Without any of them, the email moves to a fresh account with a new identity.

## The user server (`user-server/`)

A Cloudflare Worker with a D1 database (`me.makework.dev` for MakeWork's own). It keeps accounts, private messages
waiting for their recipient (end-to-end encrypted, kept until confirmed or 30 days), friends and blocks, vaults (small
documents the app encrypts for its own account, such as the joined workspaces and synced preferences), and sends mail
through Resend. Requests that act as an account are signed with its key (`X-MW-Auth`); there are no sessions. Setup,
secrets, migrations and deploying: `user-server/README.md`.

## The TURN worker (`turn-worker/`)

Hands out short-lived TURN credentials (Cloudflare Calls TURN) to signed-in accounts, so members behind strict NATs can
still link (`p2p/ice.ts`). Calls depend on it: media only goes over direct links (decision 0019). Setup:
`turn-worker/README.md`.

## Private messages (`app/src/dm/`)

A Trystero room per pair of accounts, sealed with keys from the two accounts' ECDH (`dm/crypto.ts`), with messages left
on the user server while the other side is offline. Friends are mutual; messages from strangers are refused unless the
recipient allows them.
