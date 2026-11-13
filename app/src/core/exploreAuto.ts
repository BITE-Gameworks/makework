// Automatically creates the Explore MakeWork preset for new or offline users on their first start.
// Only when the account has no workspace, and marked per account so deleting it doesn't bring it back.
import { account } from "./account";
import { readJson, writeJson } from "./storage";
import { importExplorePreset } from "./explorePreset";

const key = (id: string) => `mw.explore.offered.${id}`;

export async function ensureExplorePreset(existing: number): Promise<void> {
  const me = account();
  if (!me || existing > 0) return;
  const offered = readJson<boolean>(key(me.id), false);
  if (offered) return;
  writeJson(key(me.id), true);
  try {
    await importExplorePreset();
  } catch (e) {
    console.warn("Explore preset not created:", e);
  }
}
