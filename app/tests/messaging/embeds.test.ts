import { describe, expect, it } from "vitest";
import { videoEmbeds } from "../../src/messaging/embeds";

describe("videoEmbeds", () => {
  it("finds YouTube, Vimeo and video file links once each", () => {
    const body = "see https://youtu.be/dQw4w9WgXcQ, and https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3 "
      + "https://vimeo.com/76979871 https://example.com/clip.mp4?x=1 https://example.com/page";
    expect(videoEmbeds(body).map((e) => [e.provider, e.src])).toEqual([
      ["YouTube", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0"],
      ["Vimeo", "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1"],
      ["Video", "https://example.com/clip.mp4?x=1"],
    ]);
  });

  it("ignores other links", () => {
    expect(videoEmbeds("https://example.com/watch?v=abc https://youtube.com/")).toEqual([]);
  });
});
