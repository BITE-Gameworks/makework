import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS script without types
import { nodePackage } from "../../scripts/node-package.mjs";

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, string | Record<string, string>>;
};

const appFile = (path: string) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
const app: Manifest = appFile("package.json");
const lock: { packages: Record<string, Manifest> } = appFile("package-lock.json");

/** The name an override key is for: `minimatch@>=7 <11` is for minimatch, `@scope/name@1` for @scope/name. */
function overriddenName(key: string): string {
  const at = key.indexOf("@", 1);
  return at < 0 ? key : key.slice(0, at);
}

/** The packages app replaces with a folder in app/vendor, and the `file:vendor/...` spec that points there. */
function standInsOf(manifest: Manifest): Map<string, string> {
  const found = new Map<string, string>();
  for (const [key, value] of Object.entries(manifest.overrides ?? {})) {
    if (typeof value !== "string") continue;
    const spec = value.startsWith("$")
      ? (manifest.devDependencies?.[value.slice(1)] ?? manifest.dependencies?.[value.slice(1)])
      : value;
    if (spec?.startsWith("file:vendor/")) found.set(overriddenName(key), spec);
  }
  return found;
}

/** Where npm puts `name` for the package installed at `from` ("" is the root): its own node_modules, then each parent's. */
function installedAt(from: string, name: string): string | undefined {
  let dir = from;
  for (;;) {
    const path = `${dir ? `${dir}/` : ""}node_modules/${name}`;
    if (lock.packages[path]) return path;
    if (!dir) return undefined;
    const parent = dir.lastIndexOf("/node_modules/");
    dir = parent < 0 ? "" : dir.slice(0, parent);
  }
}

/** The names of every package installed for these root dependencies, following app's lockfile. */
function packagesUnder(roots: string[]): Set<string> {
  const names = new Set<string>();
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    names.add(path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length));
    const entry = lock.packages[path];
    const deps = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies };
    for (const dep of Object.keys(deps)) {
      const at = installedAt(path, dep);
      if (at) visit(at);
    }
  };
  for (const root of roots) {
    const at = installedAt("", root);
    if (!at) throw new Error(`${root} isn't in app/package-lock.json`);
    visit(at);
  }
  return names;
}

describe("the node's package.json", () => {
  it("carries every stand-in app uses for a package under the node's dependencies", () => {
    const pkg = nodePackage(app) as Manifest & { dependencies: Record<string, string> };
    const installed = Object.entries(pkg.dependencies).filter(([, spec]) => !spec.startsWith("file:")).map(([name]) => name);
    const under = packagesUnder(installed);
    const needed = [...standInsOf(app)].filter(([name]) => under.has(name));

    // mediasoup -> node-fetch -> fetch-blob -> node-domexception (deprecated: "Use your platform's native
    // DOMException instead"), the warning a node's `npm install` printed on a server.
    expect(needed.map(([name]) => name)).toContain("node-domexception");
    for (const [name, spec] of needed) {
      expect(pkg.overrides?.[name], `override for ${name}`).toBe(spec);
      expect(pkg.dependencies[name], `dependency on ${name}`).toBe(spec);
      expect(existsSync(new URL(`../../${spec.slice("file:".length)}/package.json`, import.meta.url))).toBe(true);
    }
  });
});
