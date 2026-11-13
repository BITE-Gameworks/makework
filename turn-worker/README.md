# TURN server

Members connect to each other directly over WebRTC (free). When two members can't, but both reach a third, the
third passes their traffic along (free). Only when neither works does the app ask this
worker for Cloudflare TURN credentials, which relay through Cloudflare.

Cloudflare TURN is free up to 1,000 GB a month and billed above that. This worker checks the month's usage before
handing out credentials and stops at `CAP_GB` (500 by default). Credentials last 30 minutes, so a cut-off takes
effect within that. If the usage can't be checked, it hands out nothing.

Only accounts of your user server get credentials, so **set up the user server first**: the app signs the request
with the account key (`X-MW-Auth`), checked against the key in the user server's D1 database, which this worker shares
(binding `DB`, table `turn_grants` from the user server's migrations). Each account gets `PER_ACCOUNT_HOUR` and each address
`PER_IP_HOUR` credentials an hour; the app asks again every 20 minutes while it needs TURN.

## Setup

You need the same Cloudflare account as your user server and Node.js 22 or newer. Put the user server's database id
into `wrangler.toml` (`npx wrangler d1 list` shows it).

1. Cloudflare dashboard > Realtime > TURN Server > Create. Note the **Turn Token ID** and **API Token**.
2. My Profile > API Tokens > Create Token > Custom token, permission **Account > Account Analytics > Read**.
   Note the token.
3. Note your **Account ID**: the 32-character part of the dashboard URL after `dash.cloudflare.com/`, or the
   Account ID row of `npx wrangler whoami` (after `npx wrangler login`).
4. From this folder:
   ```
   npx wrangler login
   npx wrangler secret put TURN_KEY_ID           # the Turn Token ID
   npx wrangler secret put TURN_KEY_API_TOKEN    # the TURN API Token
   npx wrangler secret put ANALYTICS_API_TOKEN   # the analytics token from step 2
   npx wrangler secret put ACCOUNT_ID
   npx wrangler deploy
   ```
   Optional: `CAP_GB` in `wrangler.toml` `[vars]` for another cap.
5. On your domain (it must be on Cloudflare): Workers & Pages > makework-turn > Settings > Domains & Routes >
   Add > Custom domain, e.g. `turn.example.com`.
6. In the app, everyone who should use it enters the address in Settings > Connections > TURN server. They need an
   account on your user server.

Check: opening the URL in a browser shows `{"iceServers":[],"reason":"not signed by an account"}` (it is unsigned);
the app gets `{"iceServers":[...],"ttl":1800}`. `{"iceServers":[],"reason":...}` always says why not.

The worker runs on the free Workers plan, which stops at its limits instead of billing.

## Updating

Copy `worker.js` from a newer download over yours and run `npx wrangler deploy`. Keep your `wrangler.toml`: the
download's has no database id.

## With the source

This section stays out of the download (`app/scripts/pack-servers.mjs`), and so do MakeWork's own values in
`wrangler.toml`. To change the app's default, put the URL in `builtInUrl` in `app/src/p2p/ice.ts`, or `VITE_TURN_URL`
in `app/.env.local` to try it first, and rebuild. `app/tests/p2p/turnWorker.test.ts` runs this worker in process on
`node:sqlite` (`app/tests/d1.ts`), with Cloudflare's APIs stubbed.
