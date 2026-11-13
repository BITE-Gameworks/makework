# User server

MakeWork's own accounts service, a small auth and mailbox service. It keeps:

- **Accounts**: username (anyone may share one; a tag from the id tells them apart), public key, profile and the
  email people sign in with (confirmed with an emailed code, never shown to others). Password accounts also keep
  their private key here, locked on the user's computer with their password, plus a verifier for signing in with
  that password elsewhere. The password itself never arrives here. The password alone doesn't get the key either:
  signing in with it on another computer also takes a code from the owner's authenticator app (TOTP, with ten
  one-time backup codes) when they turned one on, else a sign-in code mailed to the account's email.
- **Recovery copies**, for password resets, only when the owner turns one on: the account key encrypted with this
  server's `RECOVERY_SECRET`. Whoever runs the server can read these, so they are off by default and the app suggests
  a recovery key instead (its locked copy is kept here too, but this server can't open it).
- **Private messages waiting for their recipient**, end-to-end encrypted. They are deleted once the recipient's app
  picks them up and confirms them, or after 30 days. Messages between two people who are both online go straight
  from app to app and never come here. Attachments never come here at all: the recipient downloads them from the
  sender while both are online.
- **Vaults**: small documents the app encrypts for its own account, e.g. the invite codes of the servers it
  joined, so the account's other computers join them too. Only the account can read them.

It also passes on **feedback and crash reports** people choose to send from the app (Settings > About): they are
mailed to `FEEDBACK_TO` and not kept here. No account is needed; each address can send 10 an hour and everyone
together 50, so they can't use up the mail quota sign-in codes need. Without `FEEDBACK_TO` the server refuses them.
`GET /` reports `version` (`serverVersion` in `worker.js`, raise it when deploying a change), shown in the app.

Requests that act as an account are signed with that account's key (`X-MW-Auth`); there are no sessions or cookies.
`DELETE /me` deletes the signed-in account and everything kept for it or about it (messages, vaults, friends,
blocks, TURN grants, resets). Only its id stays, in `deleted_accounts`, so a device still signed in can't publish it
again.
`POST /report` mails a report about an account to `FEEDBACK_TO`, with the reporter's account and email for an
answer, and keeps nothing. Each account can send 5 an hour, within the feedback limit for everyone.
It runs as a Cloudflare Worker with a D1 database, on the free Workers plan (which stops at its limits instead of
billing).

## Setup

You need a Cloudflare account and Node.js 22 or newer. Create the database, put its id into `wrangler.toml`, then
run the rest from this folder:

```
npx wrangler login
npx wrangler d1 create makework-users        # put the printed database_id into wrangler.toml; keep binding = "DB"
npx wrangler d1 migrations apply makework-users --remote   # again whenever migrations/ gets a new file
npx wrangler secret put RECOVERY_SECRET          # a long random value; losing it breaks every recovery copy
npx wrangler deploy
```

Emails (sign-up codes, sign-in codes, password resets) go out through [Resend](https://resend.com) (free plan:
about 3,000 a month, 100 a day; sending pauses at the limit, and so do password sign-ins on computers that don't
have the account yet):

1. Make a Resend account, add your domain under Domains and copy the DNS records it shows into
   Cloudflare (DNS > Records). Wait until Resend shows the domain as verified.
2. Create an API key with "Sending access" and run `npx wrangler secret put RESEND_API_KEY` with it.

Sign in with GitHub (optional; the button only shows once both secrets are set):

1. On GitHub: Settings > Developer settings > OAuth Apps > New OAuth App. Homepage your site,
   authorization callback URL your user server's address + `/github/callback`.
2. Copy the client id, generate a client secret, and run `npx wrangler secret put GITHUB_CLIENT_ID` and
   `npx wrangler secret put GITHUB_CLIENT_SECRET`.
3. In the same OAuth App, tick "Enable Device Flow". The desktop app then signs in to GitHub for repositories with
   it (push, pull and fetch use only MakeWork's own sign-in, never another app's). The user server hands out just
   the client id (`github_client_id` in `GET /`), which isn't secret.
4. `APP_ORIGINS` in `wrangler.toml` lists the origins the web app is served from (comma separated). A sign-in from
   the browser build only gets its answer back at one of them (`<origin>/github-callback.html`); the desktop app
   gets it on a one-off loopback port. Add your own origin if you serve the web build elsewhere.

`MAIL_FROM` in `wrangler.toml` must be an address on the verified domain. `sendEmail` in `worker.js` is the one
place that sends mail, if the provider ever changes. To receive feedback and crash reports from people using this
server, set `FEEDBACK_TO` there too.

Then on your domain (it must be on Cloudflare): Workers & Pages > makework-user-server > Settings > Domains & Routes >
Add > Custom domain, e.g. `me.example.com`.

Check: opening the URL shows `{"makework":"user-server","v":1,"version":...,"name":"MakeWork accounts",...}`.

The app uses MakeWork's own user server unless the user picks another one (the sign-in screen and Settings > Account
both have "Change"), so everyone who should use yours picks it there. Accounts on it are separate from accounts on
MakeWork's.

## Updating

Copy `worker.js` and `migrations/` from a newer download over yours. Keep your `wrangler.toml`: the download's has no
database id. Then:

```
npx wrangler d1 migrations apply makework-users --remote
npx wrangler deploy
```

From 1.3.0 a password sign-in on a computer that doesn't have the account needs a code from the account's email,
and from 1.4.0 (migration `0012_totp.sql`) a code from the authenticator app for accounts that turned one on. Apps
from before that can't enter one (they are told to update), so update the app people use before this server.

## Trying it locally

```
npx wrangler d1 migrations apply makework-users --local
npx wrangler dev --local                        # http://localhost:8787
```

Locally there is no `RESEND_API_KEY`: emails (with their codes) are printed in the `wrangler dev` output. Give it a
`RECOVERY_SECRET` in `.dev.vars` to try recovery copies.

and in the app pick `localhost:8787` as the user server.

## With the source

This section stays out of the download (`app/scripts/pack-servers.mjs`), and so do MakeWork's own values in
`wrangler.toml`. `VITE_USER_SERVER_URL` in `app/.env.local` changes the app's default for a build.
`app/tests/core/userServer.test.ts` runs this worker in process on `node:sqlite`.
