// The host's video for the others' mirror, which can't play a page's media (its `blob:` sources exist only in the
// host's page). First the video element's own stream (`captureElement`: its picture and sound, nothing drawn over
// it); where that fails, the host's webview as it shows, picture and sound, cut to the video's part
// (`captureVideo`). Each watcher lays it over the same element in their mirror.
import { desktop, type BrowserVideo } from "../../../core/desktop";

// The part of a video element in view, as fractions of its box; what the watchers need to place the picture.
// `whole`: the stream is the element's own video, shown in its whole box the way the page shows it.
export type VideoRegion = { id: number; fx0: number; fy0: number; fx1: number; fy1: number; whole?: boolean };

export const isVideoRegion = (value: unknown): value is VideoRegion => {
  const r = value as Record<string, unknown> | null;
  return !!r && typeof r === "object" && Number.isInteger(r.id) && Number(r.id) > 0
    && ["fx0", "fy0", "fx1", "fy1"].every((k) => Number.isFinite(r[k]) && Number(r[k]) >= 0 && Number(r[k]) <= 1);
};

// A fixed picture size: the region changes size as the player does (theater mode, a window resize), and every
// change of the stream's size made the picture jump. Watchers stretch it back over the element's box.
const outWidth = 1280;
const outHeight = 720;
const frameRate = 30;

export interface VideoShare {
  stream: MediaStream;
  // The video node an element capture follows; absent for the cut-out of the page.
  nodeId?: number;
  stop(): void;
}

export async function captureElement(guestId: number, nodeId: number): Promise<VideoShare | null> {
  const bridge = desktop?.browserElementCapture;
  if (!bridge) return null;
  const pc = new RTCPeerConnection();
  const stream = new MediaStream();
  pc.addEventListener("track", ({ track }) => {
    for (const old of stream.getTracks()) if (old.kind === track.kind) stream.removeTrack(old);
    stream.addTrack(track);
  });
  const stop = () => {
    pc.close();
    void bridge.stop(guestId).catch(() => {});
  };
  try {
    const offer = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => finish(null), 5000);
      const off = bridge.onOffer((from, id, sdp) => from === guestId && id === nodeId && finish(sdp));
      const finish = (sdp: string | null) => {
        clearTimeout(timer);
        off();
        resolve(sdp);
      };
      void bridge.start(guestId, nodeId).then((ok) => ok || finish(null));
    });
    if (!offer) throw new Error("no offer");
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && resolve());
      setTimeout(resolve, 2000);
    });
    await bridge.answer(guestId, pc.localDescription!.sdp);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("not connected")), 5000);
      const check = () => {
        if (pc.connectionState === "connected" && stream.getVideoTracks().length) {
          clearTimeout(timer);
          resolve();
        } else if (pc.connectionState === "failed") {
          clearTimeout(timer);
          reject(new Error("failed"));
        }
      };
      pc.addEventListener("connectionstatechange", check);
      pc.addEventListener("track", check);
      check();
    });
    return { stream, nodeId, stop };
  } catch {
    stop();
    return null;
  }
}

// `region()` is read every frame: the video's place in the page (page px), so the crop follows scrolling.
export async function captureVideo(guestId: number, region: () => BrowserVideo | null): Promise<VideoShare | null> {
  if (!desktop?.browserCapture || !(await desktop.browserCapture(guestId))) return null;
  const source = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate }, audio: true });
  const input = document.createElement("video");
  input.muted = true;
  input.srcObject = source;
  await input.play().catch(() => {});
  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const draw = canvas.getContext("2d")!;
  const picture = canvas.captureStream(frameRate);
  let stopped = false;
  const frame = () => {
    if (stopped) return;
    const at = region();
    if (at && input.videoWidth) {
      // The capture is the page in device px; the region is in page px.
      const ratio = input.videoWidth / at.vw;
      draw.drawImage(input, at.x * ratio, at.y * ratio, at.w * ratio, at.h * ratio, 0, 0, outWidth, outHeight);
    }
    input.requestVideoFrameCallback(frame);
  };
  input.requestVideoFrameCallback(frame);
  const stream = new MediaStream([...picture.getVideoTracks(), ...source.getAudioTracks()]);
  return {
    stream,
    stop: () => {
      stopped = true;
      source.getTracks().forEach((t) => t.stop());
      picture.getTracks().forEach((t) => t.stop());
      input.srcObject = null;
    },
  };
}
