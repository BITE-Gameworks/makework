/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import type { Plugin } from "vite";

// Plain .ts modules hold app state and start timers, listeners and subscriptions. Hot-swapping one leaves
// the old copy running next to the new one, so changes to them reload the page instead.
function reloadStateModules(): Plugin {
  return {
    name: "makework-reload-state-modules",
    hotUpdate({ file }) {
      if (file.includes("/src/") && file.endsWith(".ts")) {
        this.environment.hot.send({ type: "full-reload" });
        return [];
      }
    },
  };
}

// Scripts come only from the app's own files and installed plugins' blob modules, so markup from synced data or a
// mirrored page can't run. Everything else stays open: members choose their own servers and media hosts. Frames
// without a network address (srcdoc, the browser mirror) inherit this; plugin views load public/sandbox.html instead.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' * mwbrowser:",
  "img-src * data: blob: mwc: mwbrowser: mwmedia:",
  "media-src * data: blob: mwc: mwbrowser: mwmedia:",
  "font-src 'self' * data: mwc: mwbrowser:",
  "connect-src * data: blob: mwc: mwbrowser: mwmedia:",
  "frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

// Builds only: Vite's dev server injects inline scripts of its own.
function appContentSecurityPolicy(): Plugin {
  return {
    name: "makework-content-security-policy",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: contentSecurityPolicy }, injectTo: "head-prepend" }],
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [solid(), reloadStateModules(), appContentSecurityPolicy()],
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version) },
  // y-monaco still names Monaco's pre-0.57 ESM path; Monaco 0.57's export map exposes the same module here.
  resolve: { alias: { "monaco-editor/esm/vs/editor/editor.api.js": "monaco-editor/editor/editor.api" } },
  // ffmpeg.wasm starts its worker from its own file; pre-bundled, that file isn't there in dev.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg"] },
  test: {
    environment: "node",
    // `npm run coverage`: lcov for SonarQube (sonar-project.properties at the repository root).
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text-summary"],
      include: ["src/**/*.{ts,tsx}", "electron/**/*.{js,cjs,mjs}"],
      exclude: ["**/*.d.ts"],
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/electron/**", "**/release/**"] },
  },
}));
