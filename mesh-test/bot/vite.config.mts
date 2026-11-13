// Bundles the stress-test bot (bot.ts) like app/vite.node.config.ts bundles the node: everything but werift, for plain
// Node.js. Run inside the mwt-node image build, where this folder is /app/mwt-bot and the app source /app/src;
// writes /app/dist-node/mwt-bot.mjs next to the node (after `npm run build:node`, which empties the folder).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  publicDir: false,
  resolve: { alias: { "@app": fileURLToPath(new URL("../src", import.meta.url)) } },
  build: {
    ssr: fileURLToPath(new URL("bot.ts", import.meta.url)),
    outDir: fileURLToPath(new URL("../dist-node", import.meta.url)),
    emptyOutDir: false,
    target: "node22",
    rollupOptions: { output: { entryFileNames: "mwt-bot.mjs", format: "es" } },
  },
  ssr: { noExternal: true, external: ["werift", "maxmind"], target: "node" },
});
