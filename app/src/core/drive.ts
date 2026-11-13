// The Google account's MakeWork key, kept in its hidden app folder in Google Drive (only this app can see it), so
// signing in with the same Google account is the same MakeWork account on every device.
import { AuthError } from "./account";

const fileName = "account.json";
const api = "https://www.googleapis.com/drive/v3/files";

async function call(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (response.ok) return response;
  const body = await response.text();
  if (response.status === 403 && body.includes("accessNotConfigured"))
    throw new AuthError("Google Drive isn't enabled for MakeWork's Google project yet.");
  if (response.status === 403 || response.status === 401)
    throw new AuthError("MakeWork needs access to its own folder in your Google Drive to keep your account. Sign in again and allow it.");
  throw new Error(`Google Drive answered ${response.status}: ${body.slice(0, 200)}`);
}

async function findFile(token: string): Promise<string | null> {
  const query = new URLSearchParams({
    spaces: "appDataFolder", q: `name = '${fileName}'`, fields: "files(id)", orderBy: "modifiedTime desc",
  });
  const { files } = await (await call(token, `${api}?${query}`)).json() as { files: { id: string }[] };
  return files[0]?.id ?? null;
}

export async function readDriveAccount<T>(token: string): Promise<T | null> {
  const id = await findFile(token);
  return id ? (await call(token, `${api}/${id}?alt=media`)).json() as Promise<T> : null;
}

// A file already there is renamed, not deleted, so a replaced account can still be recovered by hand.
export async function writeDriveAccount(token: string, account: object, replacedName: string): Promise<void> {
  const old = await findFile(token);
  if (old) await call(token, `${api}/${old}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: replacedName }),
  });
  const boundary = `mw${crypto.randomUUID()}`;
  const body = [
    `--${boundary}`, "Content-Type: application/json; charset=UTF-8", "",
    JSON.stringify({ name: fileName, parents: ["appDataFolder"] }),
    `--${boundary}`, "Content-Type: application/json", "",
    JSON.stringify(account),
    `--${boundary}--`, "",
  ].join("\r\n");
  await call(token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
}

// Every file in MakeWork's app folder: the account and the ones it replaced.
export async function deleteDriveAccounts(token: string): Promise<void> {
  const query = new URLSearchParams({ spaces: "appDataFolder", fields: "files(id)", pageSize: "1000" });
  const { files } = await (await call(token, `${api}?${query}`)).json() as { files: { id: string }[] };
  for (const file of files) await call(token, `${api}/${file.id}`, { method: "DELETE" });
}
