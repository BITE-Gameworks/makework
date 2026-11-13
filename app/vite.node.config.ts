// Builds the node (src/node/main.ts) into dist-node/makework-node.mjs for plain Node.js. Everything is bundled except
// WebRTC (werift), the GeoIP reader and the SFU worker (mediasoup, a native addon), which dist-node/package.json
// lists for `npm install` there.
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

// Members wait passively in a server's hub room until they hear an active peer (a node) announce itself
// (p2p/sync.ts), and Trystero's Nostr strategy announces a settled room only once a minute: joiners waited up to a
// minute for a node (mesh-test s9). Nodes announce every 4 s instead; the app keeps Trystero's default. The build
// fails if the line changes in a Trystero update, rather than quietly going back to a minute.
function nodeAnnounces(): Plugin {
  const from = "const steadyAnnounceIntervalMs = 6e4;";
  let applied = false;
  return {
    name: "makework-node-announces",
    transform(code, id) {
      if (!id.includes("@trystero-p2p/nostr/dist/index.mjs")) return null;
      if (!code.includes(from)) this.error(`Trystero's Nostr strategy changed: "${from}" not found (see vite.node.config.ts).`);
      applied = true;
      return code.replace(from, "const steadyAnnounceIntervalMs = 4e3;");
    },
    buildEnd(error) {
      if (!error && !applied) this.error("Trystero's Nostr strategy wasn't found to change (see nodeAnnounces in vite.node.config.ts).");
    },
  };
}

// A node sets up at most this many connections at once per room; announces and offers from more peers are left
// unanswered, and those peers try again with their next announce. A burst of joiners otherwise made the node set up
// every connection at the same moment, and on a busy machine the handshakes timed out and were retried (mesh-test s9,
// NODES-REPORT.md A5). Trystero has no option for it; like `nodeAnnounces`, the build fails if its code changes.
const settingUpAtOnce = 8;

function nodePacing(): Plugin {
  const announce = "const handleAnnouncement = async (ctx, relayId, peerId, signalPeer, retryAttempt = 0) => {\n\tconst state = ctx.peerStates[peerId];\n";
  const offer = "const handleOffer = async (ctx, relayId, peerId, offer, offerId, signalPeer) => {\n\tconst state = getState(ctx.peerStates, peerId);\n";
  const pending = "const mwSettingUp = (ctx, peerId) => Object.entries(ctx.peerStates).filter(([id, s]) => id !== peerId && !s.connectedPeer"
    + " && (s.offerPeer || s.answeringPeer || s.offerInitPromise)).length;\n";
  let applied = false;
  return {
    name: "makework-node-pacing",
    transform(code, id) {
      // Trystero's core is the patched copy in vendor/ (vendor/trystero-core/README.md): linked by npm, or copied into
      // node_modules with `install-links`.
      if (!/(vendor\/trystero-core|@trystero-p2p\/core)\/lib\/signal-handler\.mjs$/.test(id)) return null;
      if (!code.includes(announce) || !code.includes(offer)) this.error("Trystero's signal handler changed (see nodePacing in vite.node.config.ts).");
      applied = true;
      return code
        .replace(announce, `${pending}${announce}\tif (state && !state.connectedPeer && !state.offerPeer && mwSettingUp(ctx, peerId) >= ${settingUpAtOnce}) { clearOfferRelayIfPlaceholder(state, relayId); return; }\n`)
        .replace(offer, `${offer}\tif (!state.answeringPeer && !state.offerAnswered && !state.connectedPeer && mwSettingUp(ctx, peerId) >= ${settingUpAtOnce}) return;\n`);
    },
    // Moving the module (it was in node_modules until 2026-10-16) left the pacing out without a word.
    buildEnd(error) {
      if (!error && !applied) this.error("Trystero's signal handler wasn't found to change (see nodePacing in vite.node.config.ts).");
    },
  };
}

export default defineConfig({
  publicDir: false,
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version) },
  plugins: [nodeAnnounces(), nodePacing()],
  build: {
    ssr: "src/node/main.ts",
    outDir: "dist-node",
    emptyOutDir: true,
    target: "node22",
    rollupOptions: { output: { entryFileNames: "makework-node.mjs", format: "es" } },
  },
  ssr: { noExternal: true, external: ["werift", "maxmind", "mediasoup"], target: "node" },
});
