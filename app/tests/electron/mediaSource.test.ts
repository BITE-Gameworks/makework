import { describe, expect, it } from "vitest";
import { pickStreams } from "../../electron/mediaSource.js";

const video = { url: "https://v/video", vcodec: "vp9", acodec: "none" };
const audio = { url: "https://v/audio", vcodec: "none", acodec: "opus" };
const both = { url: "https://v/both", vcodec: "avc1", acodec: "mp4a" };

describe("media streams", () => {
  it("keeps a separate picture and sound apart", () => {
    const found = pickStreams({ requested_formats: [video, audio] }, true);
    expect(found.picture).toBe(video);
    expect(found.sound).toBe(audio);
    expect(found.combined).toBe(false);
  });
  it("uses one stream for both when it holds both", () => {
    const found = pickStreams(both, true);
    expect(found.picture).toBe(both);
    expect(found.combined).toBe(true);
  });
  it("gives no picture when only sound is wanted", () => {
    const found = pickStreams({ requested_formats: [video, audio] }, false);
    expect(found.picture).toBeNull();
    expect(found.sound).toBe(audio);
  });
  it("takes a combined stream as the sound of an audio request", () => {
    const found = pickStreams(both, false);
    expect(found.picture).toBeNull();
    expect(found.sound).toBe(both);
  });
});

import { createMediaSource } from "../../electron/mediaSource.js";

// A yt-dlp that always fails with the given message.
const failing = (message: string, calls: string[][] = []) => (_command: string, args: string[]) => {
  calls.push(args);
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const child = {
    stdout: { on: () => {} },
    stderr: { on: (_: string, cb: (chunk: string) => void) => setTimeout(() => cb(`ERROR: ${message}\n`), 0) },
    kill: () => {},
    on: (event: string, cb: (...a: unknown[]) => void) => { handlers[event] = cb; if (event === "close") setTimeout(() => cb(1), 5); },
  };
  return child as never;
};

describe("media links yt-dlp cannot read", () => {
  it("plays a media file the browser's own request can reach", async () => {
    const source = createMediaSource({
      spawn: failing("[generic] Unable to download webpage: HTTP Error 403: Forbidden"),
      fetch: async () => new Response("x", { status: 206, headers: { "content-type": "audio/mpeg" } }),
    });
    const found = await source.resolve("http://93.184.216.34/songs/a%20b.mp3", true);
    expect(found).toMatchObject({ title: "a b.mp3", picture: null });
    expect(found.sound).toBeTruthy();
  });

  it("keeps yt-dlp's reason, with advice, when the link is no media file", async () => {
    const source = createMediaSource({
      spawn: failing("[youtube] x: Requested format is not available. Use --list-formats for a list of available formats"),
      fetch: async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    await expect(source.resolve("http://93.184.216.34/page", false)).rejects.toThrow(/Requested format is not available.*yt-dlp -U/);
  });

  it("asks YouTube again through another player", async () => {
    const calls: string[][] = [];
    const source = createMediaSource({ spawn: failing("[youtube] x: Requested format is not available.", calls), fetch: async () => new Response("", { status: 404 }) });
    await expect(source.resolve("https://www.youtube.com/watch?v=x", false)).rejects.toThrow();
    expect(calls).toHaveLength(2);
    expect(calls[1].join(" ")).toContain("youtube:player_client=android_vr");
  });
});

describe("the app's own yt-dlp", () => {
  it("picks the standalone build for each system", async () => {
    const { ytDlpBuild } = await import("../../electron/mediaSource.js");
    expect(ytDlpBuild("linux", "x64")).toBe("yt-dlp_linux");
    expect(ytDlpBuild("linux", "arm64")).toBe("yt-dlp_linux_aarch64");
    expect(ytDlpBuild("win32", "x64")).toBe("yt-dlp.exe");
    expect(ytDlpBuild("darwin", "arm64")).toBe("yt-dlp_macos");
    expect(ytDlpBuild("freebsd", "x64")).toBeNull();
  });
});
