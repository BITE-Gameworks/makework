// Media for the media bot: yt-dlp turns a page address (YouTube and many other sites, or a plain media link) into direct
// stream addresses, and mwmedia://stream/<token> hands them to the page from this origin, so the page can play them and
// capture the result into a call. Only public hosts are fetched, redirects included. No media is downloaded to disk.
// The app keeps its own copy of yt-dlp (`toolDir`), fetched from its GitHub releases on first use and updated weekly, since
// a system copy is often too old for YouTube; the system one is used when that fails.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { followPublic, publicUrl } from "./webLookup.js";

const resolveTimeoutMs = 60_000;
const maxSessions = 4;
const maxPlaylist = 200;
const maxAvailableWaitMs = 10_000;

const pictureFormat = "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b";
const soundFormat = "bestaudio/best";
const videoExtensions = new Set(["mp4", "webm", "mkv", "mov", "m4v", "ogv"]);
const mediaFile = /\.(mp4|webm|mkv|mov|m4v|ogv|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
const updateEveryMs = 7 * 24 * 60 * 60_000;
const releases = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";

// The standalone yt-dlp build for this computer, or null where there is none.
export function ytDlpBuild(platform, arch) {
  if (platform === "win32") return "yt-dlp.exe";
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "linux") return arch === "arm64" ? "yt-dlp_linux_aarch64" : arch === "x64" ? "yt-dlp_linux" : null;
  return null;
}

// The app's own yt-dlp: its path once it is there (fetched on first use), else null (the system one is used then).
// `runtime`: a JavaScript runtime yt-dlp may use for YouTube (the app's own binary run as Node); only the app's copy
// knows the option.
function createYtDlp({ toolDir, fetch, spawn, platform, arch, runtime }) {
  const build = toolDir ? ytDlpBuild(platform, arch) : null;
  const file = build ? path.join(toolDir, build) : null;
  let fetching = null;
  let checked = false;

  async function download() {
    await fs.mkdir(toolDir, { recursive: true });
    const response = await fetch(releases + build, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    // From the same place as the file: it catches a damaged download or a swapped mirror, not a compromised release.
    const sums = await fetch(`${releases}SHA2-256SUMS`, { redirect: "follow" });
    const listed = sums.ok ? (await sums.text()).split("\n").map((line) => line.trim().split(/\s+/)).find(([, name]) => name === build)?.[0] : null;
    if (!listed || listed !== createHash("sha256").update(bytes).digest("hex")) throw new Error("its checksum doesn't match");
    const part = `${file}.part`;
    await fs.writeFile(part, bytes);
    await fs.chmod(part, 0o700);
    await fs.rename(part, file);
  }

  // Asks the copy to update itself when it is a week old; never waited for (the current copy keeps working meanwhile).
  function updateLater(stats) {
    if (checked || Date.now() - stats.mtimeMs < updateEveryMs) return;
    checked = true;
    const child = spawn(file, ["-U"], { stdio: "ignore" });
    child.on("error", () => {});
    child.on("close", (code) => { if (code === 0) void fs.utimes(file, new Date(), new Date()).catch(() => {}); });
  }

  async function command() {
    if (!file) return { program: "yt-dlp", runtime: null };
    try {
      updateLater(await fs.stat(file));
    } catch {
      fetching ??= download().finally(() => { fetching = null; });
      try {
        await fetching;
      } catch (e) {
        console.warn(`yt-dlp not fetched: ${e.message}; using the system's`);
        return { program: "yt-dlp", runtime: null };
      }
    }
    return { program: file, runtime: runtime ? { args: ["--js-runtimes", `node:${runtime.path}`], env: runtime.env } : null };
  }

  return { command };
}

// What the JSON of yt-dlp says about the streams: the picture and the sound may be two separate ones.
export function pickStreams(info, wantPicture) {
  const formats = Array.isArray(info.requested_formats) && info.requested_formats.length ? info.requested_formats : [info];
  const usable = formats.filter((f) => typeof f.url === "string" && /^https?:/.test(f.url));
  // A plain link tells no codecs: its file extension says whether it holds a picture (then it holds the sound too).
  const unknown = (f) => !f.vcodec && !f.acodec;
  const hasPicture = (f) => (unknown(f) ? videoExtensions.has(String(f.ext ?? "").toLowerCase()) : !!f.vcodec && f.vcodec !== "none");
  const hasSound = (f) => (unknown(f) || !!f.acodec ? !f.acodec || f.acodec !== "none" : !hasPicture(f));
  const picture = wantPicture ? usable.find(hasPicture) ?? null : null;
  // A stream of sound alone is preferred; a picture stream that carries sound serves as both.
  const sound = usable.find((f) => hasSound(f) && !hasPicture(f)) ?? (picture && hasSound(picture) ? picture : usable.find(hasSound) ?? null);
  return { picture, sound, combined: !!picture && picture === sound };
}

export function createMediaSource({ spawn, fetch, toolDir = null, platform = process.platform, arch = process.arch, runtime = null }) {
  // session -> { streams: Map<token, { url, headers }> }
  const sessions = new Map();
  const ytDlp = createYtDlp({ toolDir, fetch, spawn, platform, arch, runtime });

  // `withRuntime`: let yt-dlp run YouTube's scripts (null when this yt-dlp can't).
  async function runYtDlp(address, options, withRuntime = false) {
    const { program, runtime: js } = await ytDlp.command();
    if (withRuntime && !js) return null;
    const extra = withRuntime ? js.args : [];
    return new Promise((resolve, reject) => {
      const child = spawn(program, ["-J", "--no-warnings", ...extra, ...options, "--", address], {
        stdio: ["ignore", "pipe", "pipe"], ...(withRuntime && js.env ? { env: { ...process.env, ...js.env } } : {}),
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("yt-dlp took too long to find the media.")); }, resolveTimeoutMs);
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { err += chunk; });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(e?.code === "ENOENT" ? "yt-dlp is not installed on the computer that hosts this bot." : `yt-dlp failed: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const line = err.split("\n").map((l) => l.trim()).findLast(Boolean) ?? "";
          return reject(new Error(line.replace(/^ERROR:\s*/, "") || "yt-dlp could not read that link."));
        }
        try { resolve(JSON.parse(out)); } catch { reject(new Error("yt-dlp gave an answer I could not read.")); }
      });
    });
  }

  function register(session, found) {
    const token = randomUUID();
    session.streams.set(token, { url: found.url, headers: found.http_headers ?? {} });
    return token;
  }

  const isYoutube = (url) => /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(url.hostname);

  // yt-dlp's answer for a link. YouTube hands out media addresses that some of its players' requests can't use
  // (refused until yt-dlp's own download dance): each setup is tried in turn and kept once its addresses answer.
  // Without a script runtime yt-dlp uses players whose addresses work as they are; the runtime and the VR player next.
  async function inspect(url, audioOnly) {
    const base = ["--no-playlist", "-f", audioOnly ? soundFormat : pictureFormat];
    const attempts = isYoutube(url)
      ? [{ options: [] }, { options: [], runtime: true }, { options: ["--extractor-args", "youtube:player_client=android_vr"] }]
      : [{ options: [] }];
    let failure = null;
    for (const attempt of attempts) {
      let info;
      try {
        info = await runYtDlp(url.toString(), [...base, ...attempt.options], attempt.runtime === true);
      } catch (e) {
        failure = e;
        if (/not installed|took too long/.test(e.message)) break;
        continue;
      }
      if (!info) continue;
      if (!isYoutube(url) || await answers(info, audioOnly)) return info;
      failure = new Error("YouTube refused the media addresses it gave.");
    }
    throw failure ?? new Error("yt-dlp could not read that link.");
  }

  // Whether the picked streams answer a request (after the time the site says they become usable).
  async function answers(info, audioOnly) {
    const { picture, sound } = pickStreams(info, !audioOnly);
    for (const found of [picture, sound]) {
      if (!found) continue;
      const wait = Number(found.available_at ?? info.available_at ?? 0) * 1000 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait + 500, maxAvailableWaitMs)));
      const response = await fetchPublic(found.url, { ...found.http_headers, Range: "bytes=0-0" });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) return false;
    }
    return true;
  }

  // A link yt-dlp could not read that is a media file itself (a site that turns its downloader away, a plain file): the
  // browser's own request is tried, and the file is played from there.
  async function probeDirect(url) {
    try {
      const response = await fetchPublic(url.toString(), { Range: "bytes=0-0" });
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      await response.body?.cancel();
      if (!response.ok || !/^(audio|video)\//.test(type) && !/^application\/(ogg|vnd\.apple\.mpegurl)/.test(type)) return null;
      if (/mpegurl/.test(type)) return null;
      const name = decodeURIComponent(url.pathname.split("/").findLast(Boolean) ?? "media");
      return { title: name, url: url.toString(), vcodec: type.startsWith("video/") ? "unknown" : "none", acodec: "unknown", ext: type.startsWith("video/") ? "mp4" : "mp3" };
    } catch {
      return null;
    }
  }

  const hint = (message) => (/format is not available|No video formats|Sign in|confirm you.re not a bot/i.test(message)
    ? `${message} (Update yt-dlp with \`yt-dlp -U\`, and install a script runtime such as deno, which YouTube needs.)`
    : message);

  async function resolve(address, audioOnly) {
    const url = await publicUrl(address);
    if (!url) throw new Error("That link is not a public web address.");
    // A link to a media file is played as it is (yt-dlp is turned away by some of the hosts that serve such files).
    let info = mediaFile.test(url.pathname) ? await probeDirect(url) : null;
    if (!info) {
      try {
        info = await inspect(url, audioOnly);
      } catch (e) {
        info = await probeDirect(url);
        if (!info) throw new Error(hint(e.message));
      }
    }
    if (info._type === "playlist" && Array.isArray(info.entries) && info.entries[0]) Object.assign(info, info.entries[0]);
    const { picture, sound, combined } = pickStreams(info, !audioOnly);
    if (!picture && !sound) throw new Error("I found nothing playable at that link.");
    if (sessions.size >= maxSessions) release([...sessions.keys()][0]);
    const session = { streams: new Map() };
    const id = randomUUID();
    sessions.set(id, session);
    const pictureToken = picture ? register(session, picture) : null;
    const soundToken = sound ? (combined ? pictureToken : register(session, sound)) : null;
    return {
      session: id,
      title: String(info.title ?? info.id ?? "media"),
      duration: typeof info.duration === "number" && info.duration > 0 ? info.duration : null,
      live: info.is_live === true,
      picture: pictureToken,
      sound: soundToken,
    };
  }

  // The entries of a playlist link (title and address each, nothing resolved yet); a link that is no playlist is its own
  // only entry.
  async function list(address) {
    const url = await publicUrl(address);
    if (!url) throw new Error("That link is not a public web address.");
    const info = await runYtDlp(url.toString(), ["--flat-playlist", "--playlist-end", String(maxPlaylist)]);
    if (!Array.isArray(info.entries)) return [{ url: url.toString(), title: String(info.title ?? ""), duration: null }];
    return info.entries.flatMap((entry) => {
      const found = String(entry?.webpage_url ?? entry?.url ?? "");
      return /^https?:\/\//.test(found)
        ? [{ url: found, title: String(entry.title ?? ""), duration: typeof entry.duration === "number" ? entry.duration : null }]
        : [];
    });
  }

  function release(id) {
    sessions.delete(id);
  }

  const fetchPublic = (address, headers) => followPublic(fetch, address, { headers });

  const served = () => ({ "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes", "Cache-Control": "no-store" });

  async function proxy(request) {
    const token = new URL(request.url).pathname.slice(1);
    const stream = [...sessions.values()].map((s) => s.streams.get(token)).find(Boolean);
    if (!stream) return new Response("Not found", { status: 404 });
    const range = request.headers.get("range");
    const upstream = await fetchPublic(stream.url, range ? { ...stream.headers, Range: range } : { ...stream.headers });
    const out = served();
    for (const name of ["content-type", "content-length", "content-range"]) {
      const value = upstream.headers.get(name);
      if (value) out[name] = value;
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }


  return { resolve, list, release, proxy };
}
