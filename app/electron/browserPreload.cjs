// Runs in every frame of a browser channel's pages, before their scripts: applies the ad blocker's cosmetic filters
// and scriptlets (adblock.js), and on the host's page records the DOM for the others' mirror. Gives the page nothing.
const { ipcRenderer, webFrame } = require("electron");

const found = ipcRenderer.sendSync("browser:cosmetics", location.href);
const maxDomEvents = 256;
const maxDomBatchBytes = 8 * 1024 * 1024;
let domRecording = false;
let stopDomRecording = null;
let domStart = 0;
let domEvents = [];
let domTimer = null;
let recordApi;

const flushDomEvents = () => {
  domTimer = null;
  if (!domEvents.length) return;
  const events = domEvents;
  domEvents = [];
  ipcRenderer.send("browser:dom-events", events);
};

const queueDomEvent = (event) => {
  if (!domRecording) return;
  let size;
  try {
    size = JSON.stringify(event).length;
  } catch {
    return;
  }
  if (size > maxDomBatchBytes) return;
  if (domEvents.length >= maxDomEvents) flushDomEvents();
  domEvents.push(event);
  if (domTimer === null) domTimer = setTimeout(flushDomEvents, 100);
};

const startDomRecording = async () => {
  if (domRecording) return;
  domRecording = true;
  const started = ++domStart;
  try {
    // A sandboxed preload can't load packages: main hands over rrweb's self-contained build, run here in the
    // preload's own world (the page can't reach it).
    recordApi ??= await ipcRenderer.invoke("browser:recorder").then((source) => {
      if (typeof source !== "string") throw new Error("no recorder");
      const module = { exports: {} };
      new Function("module", "exports", source)(module, module.exports);
      return module.exports;
    });
    const { record } = recordApi;
    if (!domRecording || started !== domStart) return;
    stopDomRecording = record({ emit: queueDomEvent });
  } catch (error) {
    if (started === domStart) {
      domRecording = false;
      console.warn("Shared browser: DOM recording unavailable", error);
    }
  }
};

const stopDomRecordingNow = () => {
  domRecording = false;
  domStart += 1;
  stopDomRecording?.();
  stopDomRecording = null;
  if (domTimer !== null) {
    clearTimeout(domTimer);
    flushDomEvents();
  }
};

// Points on the host's page and the elements under them (input.ts `Anchor`), by the recorder's node ids, which are
// the same in every member's mirror.
const anchorAt = ({ x, y }) => {
  const el = document.elementFromPoint(x, y);
  const id = el ? recordApi?.record.mirror.getId(el) : -1;
  if (!el || !(id > 0)) return null;
  const box = el.getBoundingClientRect();
  return box.width && box.height ? { id, fx: (x - box.left) / box.width, fy: (y - box.top) / box.height } : null;
};
const pointOf = ({ id, fx, fy }) => {
  const el = recordApi?.record.mirror.getNode(id);
  if (el?.nodeType !== 1 || !el.isConnected) return null;
  const box = el.getBoundingClientRect();
  return box.width || box.height ? { x: box.left + fx * box.width, y: box.top + fy * box.height } : null;
};
// The biggest video showing on the page, for the video stream over the others' mirror: its node, its box and the
// part of it inside the window.
const mainVideo = () => {
  let best = null;
  for (const video of document.querySelectorAll("video")) {
    const id = recordApi?.record.mirror.getId(video);
    const box = video.getBoundingClientRect();
    const x0 = Math.max(box.left, 0), y0 = Math.max(box.top, 0);
    const x1 = Math.min(box.right, innerWidth), y1 = Math.min(box.bottom, innerHeight);
    const area = (x1 - x0) * (y1 - y0);
    if (!(id > 0) || video.readyState < 2 || x1 <= x0 || y1 <= y0 || area < 100 * 100 || (best && best.area >= area)) continue;
    best = { area, id, playing: !video.paused, x: x0, y: y0, w: x1 - x0, h: y1 - y0,
      fx0: (x0 - box.left) / box.width, fy0: (y0 - box.top) / box.height, fx1: (x1 - box.left) / box.width, fy1: (y1 - box.top) / box.height };
  }
  if (!best) return [];
  const { area: _area, ...video } = best;
  return [{ ...video, playing: video.playing ? 1 : 0, vw: innerWidth, vh: innerHeight }];
};

ipcRenderer.on("browser:anchors", (_event, id, kind, items) => {
  let answer = [];
  try {
    if (domRecording) answer = kind === "media" ? mainVideo() : items.map(kind === "at" ? anchorAt : pointOf);
  } catch {
    answer = [];
  }
  ipcRenderer.send("browser:anchors-answer", id, answer);
});

// A video element's own picture and sound for the host's window, over a WebRTC connection on this computer (a
// MediaStream can't cross processes): nothing drawn over the video gets in, and the page keeps playing its sound.
let elementCapture = null;
const stopElementCapture = () => {
  elementCapture?.pc.close();
  elementCapture = null;
};
const iceDone = (pc) => new Promise((resolve) => {
  if (pc.iceGatheringState === "complete") return resolve();
  pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && resolve());
  setTimeout(resolve, 2000);
});
ipcRenderer.on("browser:element-capture", async (_event, nodeId) => {
  stopElementCapture();
  try {
    const video = recordApi?.record.mirror.getNode(nodeId);
    if (!domRecording || video?.nodeName !== "VIDEO") throw new Error("no video");
    const stream = video.captureStream();
    const pc = new RTCPeerConnection();
    const capture = (elementCapture = { pc });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    // A new source (the next video in a playlist) comes as new tracks.
    stream.addEventListener("addtrack", ({ track }) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === track.kind);
      if (sender) void sender.replaceTrack(track);
      else pc.addTrack(track, stream);
    });
    if (!stream.getVideoTracks().length) pc.addTransceiver("video", { direction: "sendonly" });
    if (!stream.getAudioTracks().length) pc.addTransceiver("audio", { direction: "sendonly" });
    await pc.setLocalDescription(await pc.createOffer());
    await iceDone(pc);
    if (elementCapture !== capture) return;
    ipcRenderer.send("browser:element-offer", nodeId, pc.localDescription.sdp);
  } catch {
    ipcRenderer.send("browser:element-offer", nodeId, null);
  }
});
// The hop stays on this computer, so it carries the picture at about the source's quality; the watchers'
// connections adapt it after.
const elementBitrate = 12_000_000;
ipcRenderer.on("browser:element-answer", async (_event, sdp) => {
  const pc = elementCapture?.pc;
  if (!pc) return;
  try {
    await pc.setRemoteDescription({ type: "answer", sdp });
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      params.encodings[0].maxBitrate = elementBitrate;
      // Sharp from the start: it would begin at a quarter of the size and take seconds to grow.
      params.degradationPreference = "maintain-resolution";
      await sender.setParameters(params);
    }
  } catch {
    stopElementCapture();
  }
});
ipcRenderer.on("browser:element-stop", stopElementCapture);
window.addEventListener("pagehide", stopElementCapture);

ipcRenderer.on("browser:dom-start", () => void startDomRecording());
ipcRenderer.on("browser:dom-stop", stopDomRecordingNow);

const hide = (selectors) => {
  for (let i = 0; i < selectors.length; i += 500)
    webFrame.insertCSS(`${selectors.slice(i, i + 500).join(",\n")} { display: none !important; }`, { cssOrigin: "user" });
};

if (found) {
  if (found.script) void webFrame.executeJavaScript(found.script);
  if (found.hide.length) hide(found.hide);
  // Generic rules hide by class and id: asked for the names on the page, then for new ones as the page changes.
  if (found.generic) {
    const seen = new Set();
    let pending = [];
    let timer = null;
    const note = (root, classes, ids) => {
      for (const el of [root, ...root.querySelectorAll("[class], [id]")]) {
        if (el.id && !seen.has(`#${el.id}`)) {
          seen.add(`#${el.id}`);
          ids.push(el.id);
        }
        for (const name of el.classList ?? []) {
          if (seen.has(`.${name}`)) continue;
          seen.add(`.${name}`);
          classes.push(name);
        }
      }
    };
    const scan = () => {
      timer = null;
      const classes = [];
      const ids = [];
      for (const el of pending) if (el.isConnected) note(el, classes, ids);
      pending = [];
      if (!classes.length && !ids.length) return;
      void ipcRenderer.invoke("browser:hidden-selectors", classes, ids, found.exceptions).then((selectors) => {
        if (selectors?.length) hide(selectors);
      });
    };
    const later = (el) => {
      pending.push(el);
      if (timer === null) timer = setTimeout(scan, 300);
    };
    window.addEventListener("DOMContentLoaded", () => {
      later(document.documentElement);
      new MutationObserver((changes) => {
        for (const change of changes) {
          if (change.type === "attributes") later(change.target);
          else for (const node of change.addedNodes) if (node.nodeType === 1) later(node);
        }
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"] });
    });
  }
}
