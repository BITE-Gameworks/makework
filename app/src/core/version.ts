// The app version, from app/package.json's "version" at build time. A release tag sets that (release.yml), and the
// pack script fills a plugin manifest's minApp from there.
export const appVersion = __APP_VERSION__;

// Versions come from other members too, so only ones that look like a version are shown.
export function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,40}$/.test(value);
}

// Whether a version shown for someone (several are joined with ", ") is newer than this app.
export function newerThanMine(version: string): boolean {
  return version.split(", ").some((one) => compareVersions(one, appVersion) > 0);
}

// Above 0 when `a` is newer; only major.minor.patch is compared.
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
