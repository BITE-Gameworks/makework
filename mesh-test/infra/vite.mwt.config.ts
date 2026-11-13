// Vite config of the mesh test's shared dev server (copied into the image next to the app's vite.config.ts).
// Same as the app's, except that the dependency scan covers every source file up front: a dependency first seen
// at runtime would make Vite re-optimize and reload every connected client mid-test.
import { defineConfig, mergeConfig, type UserConfig } from "vite";
import base from "./vite.config.ts";

export default defineConfig(async (env) => {
  const app = (typeof base === "function" ? await base(env) : base) as UserConfig;
  return mergeConfig(app, {
    optimizeDeps: { entries: ["index.html", "src/**/*.{ts,tsx}"] },
    server: { host: "0.0.0.0" },
  });
});
