// Packs the user server and TURN server for people to run on their own Cloudflare account, into
// dist-servers/makework-user-server.tar.gz and makework-turn-server.tar.gz (release.yml). The configs in the repo are
// MakeWork's own deployment, so what is ours comes out, and packing fails if any of it would stay. In the READMEs,
// everything from "## With the source" on stays behind.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isMain } from "./isMain.mjs";

const databaseId = /^database_id = ".*"$/m;
const mailFrom = /^MAIL_FROM = ".*"$/m;
const feedbackTo = /^FEEDBACK_TO = ".*"$/m;

function replaced(text, pattern, replacement) {
  if (!pattern.test(text)) throw new Error(`Nothing in wrangler.toml matches ${pattern}.`);
  return text.replace(pattern, replacement);
}

export function publicConfig(toml) {
  let text = replaced(toml, databaseId, 'database_id = "PUT-YOUR-DATABASE-ID-HERE"');
  if (mailFrom.test(text)) {
    text = replaced(text, mailFrom, 'MAIL_FROM = "accounts@your-domain.example"');
    text = replaced(text, feedbackTo, '# FEEDBACK_TO = "you@your-domain.example"');
  }
  // The hosted web app's addresses stay: it is the web app people can use with their own server.
  const leftOver = text.split("\n").filter((line) => !line.startsWith("APP_ORIGINS"))
    .find((line) => /makework\.dev|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(line));
  if (leftOver) throw new Error(`wrangler.toml would ship "${leftOver}".`);
  return text;
}

export function publicReadme(readme) {
  const text = readme.split("## With the source")[0].trimEnd();
  const leftOver = text.split("\n").find((line) => /app\/(src|tests|\.env)/.test(line));
  if (leftOver) throw new Error(`README would send people to the source: "${leftOver}".`);
  return `${text}\n`;
}

const repo = new URL("../../", import.meta.url);
const output = new URL("../dist-servers/", import.meta.url);

function pack(folder, name, extras) {
  const stage = new URL(`${name}/`, output);
  mkdirSync(stage, { recursive: true });
  const source = new URL(`${folder}/`, repo);
  cpSync(new URL("worker.js", source), new URL("worker.js", stage));
  for (const extra of extras) cpSync(new URL(extra, source), new URL(extra, stage), { recursive: true });
  writeFileSync(new URL("wrangler.toml", stage), publicConfig(readFileSync(new URL("wrangler.toml", source), "utf8")));
  writeFileSync(new URL("README.md", stage), publicReadme(readFileSync(new URL("README.md", source), "utf8")));
  execFileSync("tar", ["-czf", `${name}.tar.gz`, name], { cwd: output });
  console.log(`dist-servers/${name}.tar.gz`);
}

if (isMain(import.meta.url)) {
  rmSync(output, { recursive: true, force: true });
  pack("user-server", "makework-user-server", ["migrations"]);
  pack("turn-worker", "makework-turn-server", []);
}
