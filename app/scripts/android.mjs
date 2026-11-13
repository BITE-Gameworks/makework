// Builds the Android app into release/: Capacitor wraps the app's build (dist/, the one Electron loads too) in
// android/. With MAKEWORK_ANDROID_KEYSTORE (and MAKEWORK_ANDROID_KEYSTORE_PASSWORD, optionally _KEY_ALIAS and
// _KEY_PASSWORD) it is a release build signed with that key, the one releases use; without, a debug build signed with
// this computer's debug key, which installs fine but can't update an app signed with another key.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./isMain.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));
const release = join(app, "release");

/** Android's whole-number version for "major.minor.patch". */
export function versionCode(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
}

function run(command, args, cwd = app) {
  execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function android(version) {
  if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT && !existsSync(join(app, "android", "local.properties"))) {
    fail("The Android SDK wasn't found: install Android Studio (or the command line tools) and set ANDROID_HOME.");
  }
  run("npm", ["run", "build:web"]);
  run("npx", ["cap", "sync", "android"]);
  const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  const signed = !!process.env.MAKEWORK_ANDROID_KEYSTORE;
  const task = signed ? "assembleRelease" : "assembleDebug";
  run(gradlew, [task, `-PappVersion=${version}`, `-PappVersionCode=${versionCode(version)}`], join(app, "android"));
  mkdirSync(release, { recursive: true });
  const apk = join(release, `MakeWork-${version}.apk`);
  const built = signed ? join("release", "app-release.apk") : join("debug", "app-debug.apk");
  cpSync(join(app, "android", "app", "build", "outputs", "apk", built), apk);
  if (!signed) console.log("Signed with this computer's debug key (MAKEWORK_ANDROID_KEYSTORE isn't set).");
  console.log(`Built ${apk}`);
}

if (isMain(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  android(version);
}
