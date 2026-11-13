import { trimEnd } from "../core/text";

// Videos linked in a message that can play in the chat: YouTube, Vimeo and links straight to a video file.
export interface VideoEmbed {
  url: string;
  provider: "YouTube" | "Vimeo" | "Video";
  // What plays: an embed page in an iframe, or a file for <video>.
  src: string;
  kind: "frame" | "file";
}

const youtube = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:\S*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i;
const vimeo = /^https?:\/\/(?:www\.)?vimeo\.com\/(?:video\/)?(\d+)/i;
const videoFile = /^https?:\/\/\S+\.(?:mp4|webm|mov|m4v|ogv)(?:[?#]\S*)?$/i;

export function videoEmbeds(body: string, max = 3): VideoEmbed[] {
  const found: VideoEmbed[] = [];
  for (const [raw] of body.matchAll(/https?:\/\/[^\s<>()[\]]+/g)) {
    const url = trimEnd(raw, ".,!?;:'\"");
    const embed = embedFor(url);
    if (embed && !found.some((e) => e.src === embed.src)) found.push(embed);
    if (found.length === max) break;
  }
  return found;
}

function embedFor(url: string): VideoEmbed | null {
  let m = youtube.exec(url);
  if (m) return { url, provider: "YouTube", src: `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1&rel=0`, kind: "frame" };
  m = vimeo.exec(url);
  if (m) return { url, provider: "Vimeo", src: `https://player.vimeo.com/video/${m[1]}?autoplay=1&dnt=1`, kind: "frame" };
  if (videoFile.test(url)) return { url, provider: "Video", src: url, kind: "file" };
  return null;
}

// Title, channel and picture of a linked YouTube or Vimeo video, from the site's oEmbed endpoint; null when it
// doesn't answer. Asked once per link per session.
export interface VideoInfo {
  title: string;
  author: string;
  thumbnail: string | null;
}

const oembed: Partial<Record<VideoEmbed["provider"], string>> = {
  YouTube: "https://www.youtube.com/oembed?format=json&url=",
  Vimeo: "https://vimeo.com/api/oembed.json?url=",
};
const infos = new Map<string, Promise<VideoInfo | null>>();

export function videoInfo(embed: VideoEmbed): Promise<VideoInfo | null> {
  const endpoint = oembed[embed.provider];
  if (!endpoint) return Promise.resolve(null);
  let info = infos.get(embed.src);
  if (!info) {
    info = fetch(endpoint + encodeURIComponent(embed.url))
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => data && typeof data.title === "string" ? {
        title: data.title,
        author: typeof data.author_name === "string" ? data.author_name : "",
        thumbnail: typeof data.thumbnail_url === "string" && data.thumbnail_url.startsWith("https://") ? data.thumbnail_url : null,
      } : null)
      .catch(() => null);
    infos.set(embed.src, info);
  }
  return info;
}
