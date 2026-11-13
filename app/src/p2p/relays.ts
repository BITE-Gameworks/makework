// The public Nostr relays where members find each other (Trystero signaling). Members meet when they share at least
// one, so changes keep most of the list: these are 4 of the 5 Trystero picked from its defaults for our appId before
// we chose them ourselves (older clients still use those 5), plus nos.lol for nostr.christiansass.de, which stopped
// answering (mesh test). The mesh test (`mesh-test/infra/up.mjs`) reads this file.
export const relayUrls = [
  "wss://nostr.chaima.info",
  "wss://relay.grigic.org",
  "wss://relay.bitmacro.cloud",
  "wss://nostrcity-club.fly.dev",
  "wss://nos.lol",
];
