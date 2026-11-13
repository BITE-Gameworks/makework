// Voice is built into the app, not a plugin. Presence (who is where, muted, sharing) comes from the
// server's `voice` plugin; media travels over the workspace's MediaLink where it has one (serverless workspaces).
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { userMessage, type ApiClient } from "../api/client";
import { markActive } from "../core/idle";
import { member, myId } from "../core/members";
import { botTypeFor } from "../plugins/registry";
import { isMuted } from "../core/roles";
import { workspaceApi } from "../core/workspaces";
import { desktop, type ScreenSource } from "../core/desktop";
import { isPopout } from "../core/popout";
import { readJson, writeJson } from "../core/storage";
import { playSound } from "../theme/sounds";
import { canCarryMedia, mediaLink, remoteMics, remoteStream, reportedCallSize } from "./media";
import { createLimiter, isRemoteSpeaking, playRemote, remoteAnalyser, remoteLevel } from "./remote";
import { createSpeakingDetector, stepLevel } from "./levels";
import { autoGainDbFor, speechTargetDb, type MicState } from "./micProcessing";
import { capturingPttKey, inputMode, noiseSuppression, pttKey, sensitivityDb } from "./micSettings";
import { isPushToTalk, matchesPttKey, micTransmits, pttReleaseMs } from "./pushToTalk";
import micWorkletUrl from "./micWorklet.ts?worker&url";
import {
  applyCapture, captureConstraints, hintCapture, loadShareQuality, saveShareQuality, shareQualityFrom, type ShareQuality, type ShareStats,
} from "./shareQuality";
import { createSuppressor } from "./suppressor";
import { isLocallyMuted, loudnessSafety, micVolume, outputVolume, setDefaultVolume, streamVolume, userVolume } from "./volume";

export interface Participant {
  id: number;
  userId: number;
  channelId: number;
  muted: boolean;
  deafened: boolean;
  sharing: string | null;
  // The share is sound without a picture.
  soundOnly: boolean;
  camera: boolean;
}

export interface Call {
  workspaceId: string;
  channelId: number;
}

const [presence, setPresence] = createStore<Record<string, Participant[]>>({});
const presenceWatches = new Map<string, () => void>();

export async function watchVoice(workspaceId: string, api: ApiClient): Promise<void> {
  presenceWatches.get(workspaceId)?.();
  let stopped = false;
  let request = 0;
  const ext = api.plugin("voice");
  const load = async () => {
    if (stopped) return;
    const current = ++request;
    try {
      const rows = await ext.read("voice_participants");
      if (stopped || current !== request) return;
      const before = peersInCall(workspaceId);
      const wasIn = inOwnCall(workspaceId);
      setPresence(workspaceId, reconcile(rows.map((r) => ({
        id: r.id, userId: Number(r.user_id), channelId: Number(r.channel_id), muted: r.muted === true,
        deafened: r.deafened === true, sharing: r.sharing ? String(r.sharing) : null, soundOnly: r.sound_only === true, camera: r.camera === true,
      })), { key: "id" }));
      if (wasIn && !inOwnCall(workspaceId)) dropCall("no longer in the server's call list");
      else if (before) announcePeers(before, peersInCall(workspaceId)!);
    } catch (e) {
      console.warn(`Voice presence of '${workspaceId}' not loaded:`, e);
    }
  };
  const unsubscribe = ext.onEvent(() => void load());
  presenceWatches.set(workspaceId, () => { stopped = true; unsubscribe(); });
  await load();
  if (!stopped) resumeCall(workspaceId);
}

// The call to rejoin after a reload or a dropped connection, kept on this device until the user leaves it, with
// whether the user was muted or deafened in it, which the rejoin keeps.
const resumeKey = "mw.voice.resume";
type Resume = Call & { muted?: boolean; deafened?: boolean };
// Set once the app quits on purpose (`stopRejoining`): nothing is saved or rejoined any more.
let rejoinStopped = false;

function resumeCall(workspaceId?: string): void {
  // Calls stay in the main window: a view window never joins or rejoins one on its own.
  if (isPopout() || rejoinStopped) return;
  const saved = readJson<Resume | null>(resumeKey, null);
  if (!saved || call() || (workspaceId && saved.workspaceId !== workspaceId)) return;
  console.info("Voice: rejoining the call from before");
  void joinVoice(saved.workspaceId, saved.channelId, { muted: saved.muted === true, deafened: saved.deafened === true });
}

type PeerState = Map<number, { streaming: boolean }>;

function inOwnCall(workspaceId: string): boolean {
  const here = call();
  return here?.workspaceId === workspaceId && participants(workspaceId, here.channelId).some((p) => p.userId === myId(workspaceId));
}

// The call ended without the user leaving: the workspace dropped them or the device went offline.
function dropCall(reason: string): void {
  if (!call()) return;
  console.warn(`Voice: call dropped (${reason})`);
  void leaveVoice(false);
  playSound("disconnect");
}

// The media link tunes the share's senders itself as members come and go; it hears the quality when a call starts,
// the share changes, or the member picks another one.
function pushShareQuality(): void {
  const current = call();
  if (current) mediaLink(current.workspaceId)?.setQuality?.(shareQuality());
}

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => dropCall("device went offline"));
  window.addEventListener("online", () => resumeCall());
  // A call rejoined on start began without a click; browsers keep its audio paused until the first one.
  document.addEventListener("pointerdown", () => audioContext?.state === "suspended" && void audioContext.resume(), true);
}

// Everyone else in your call on that workspace; undefined when you are not in a call there.
function peersInCall(workspaceId: string): PeerState | undefined {
  const here = call();
  if (here?.workspaceId !== workspaceId) return undefined;
  const me = myId(workspaceId);
  return new Map(participants(workspaceId, here.channelId).filter((p) => p.userId !== me)
    .map((p) => [p.userId, { streaming: p.camera || p.sharing !== null }]));
}

function announcePeers(before: PeerState, after: PeerState): void {
  const joined = [...after.keys()].some((id) => !before.has(id));
  const left = [...before.keys()].some((id) => !after.has(id));
  const started = [...after].some(([id, p]) => p.streaming && before.get(id)?.streaming === false);
  if (joined) playSound("peer-join");
  else if (left) playSound("peer-leave");
  else if (started) playSound("stream-start");
}

export function participants(workspaceId: string, channelId: number): Participant[] {
  return (presence[workspaceId] ?? []).filter((p) => p.channelId === channelId);
}

// The voice channel the user is in on that workspace, if any.
export function voiceChannelOf(workspaceId: string, userId: number): number | null {
  return (presence[workspaceId] ?? []).find((p) => p.userId === userId)?.channelId ?? null;
}

const [call, setCall] = createSignal<Call | null>(null);
// Set while a join is still setting itself up (join in flight, microphone starting): no audio can arrive yet.
const [callSetup, setCallSetup] = createSignal(false);
// Reached connection once in this call, so a later call-mode switch (which re-negotiates media) never flashes the
// indicator again.
const [callConnected, setCallConnected] = createSignal(false);
const [connectingLong, setConnectingLong] = createSignal(false);
// How long a connect may take before its label says it is dragging on.
const connectingSlowMs = 15_000;
const [muted, setMuted] = createSignal(false);
const [deafened, setDeafened] = createSignal(false);
// Push to talk: the key is down, and the short tail after it comes up (so the last syllable isn't cut).
const [pttHeld, setPttHeld] = createSignal(false);
const [pttTail, setPttTail] = createSignal(false);
const [micStream, setMicStream] = createSignal<MediaStream | null>(null);
const [cameraStream, setCameraStream] = createSignal<MediaStream | null>(null);
const [screenStream, setScreenStream] = createSignal<MediaStream | null>(null);
const [level, setLevel] = createSignal(0);
const [voiceError, setVoiceError] = createSignal("");
const [inputs, setInputs] = createSignal<MediaDeviceInfo[]>([]);
const [outputs, setOutputs] = createSignal<MediaDeviceInfo[]>([]);
const [cameras, setCameras] = createSignal<MediaDeviceInfo[]>([]);
const [inputId, setInputIdSignal] = createSignal<string>(readJson("mw.voice.input", ""));
const [outputId, setOutputIdSignal] = createSignal<string>(readJson("mw.voice.output", ""));
const [cameraId, setCameraIdSignal] = createSignal<string>(readJson("mw.voice.camera", ""));
const [shareQuality, setShareQualitySignal] = createSignal<ShareQuality>(loadShareQuality());

export { call, muted, deafened, cameraStream, screenStream, level, voiceError, inputs, outputs, cameras, inputId, outputId, cameraId, shareQuality };

// The screen share's quality on this device (voice/shareQuality.ts), applied at once to a share that is running.
export function setShareQuality(wanted: ShareQuality): void {
  const quality = shareQualityFrom(wanted);
  const before = shareQuality();
  setShareQualitySignal(quality);
  saveShareQuality(quality);
  const track = picture()?.getVideoTracks()[0];
  if (track && (quality.resolution !== before.resolution || quality.frameRate !== before.frameRate)) applyCapture(track, quality);
  else if (track && quality.favour !== before.favour) hintCapture(track, quality);
  pushShareQuality();
}

// The share's live numbers for the quality control; null while no picture is shared.
export async function shareStats(): Promise<ShareStats | null> {
  const current = call();
  return current ? (await mediaLink(current.workspaceId)?.shareStats?.()) ?? null : null;
}

export const supportsOutputSelection = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

export const supportsScreenShare = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;

export const isInCall = (workspaceId: string, channelId: number) =>
  call()?.workspaceId === workspaceId && call()?.channelId === channelId;

// Whose voice the others should be able to hear: their own mute, being deafened, and a moderator's voice mute all
// mean there is nothing to wait for from them.
function audible(workspaceId: string, p: Participant): boolean {
  return !p.muted && !p.deafened && !isMuted(workspaceId, p.userId, "voice");
}

// True while this device is joining the call or still can't hear every member it should. Joining alone, or when
// nobody else is audible, counts as connected; deafened here means nothing plays by choice.
export function callConnecting(): boolean {
  const current = call();
  if (!current) return false;
  if (!canCarryMedia(current.workspaceId)) return false;
  if (callSetup()) return true;
  if (callConnected()) return false;
  if (deafened()) return false;
  const me = myId(current.workspaceId);
  return participants(current.workspaceId, current.channelId).some((p) =>
    p.userId !== me && audible(current.workspaceId, p) && !remoteStream(current.workspaceId, p.userId, "mic"));
}

// A member of this device's call none of whose media arrives here: no working connection to them yet (a bot sharing
// a video sends no mic, only its share). A muted or deafened member may have no mic at all, so with nothing else
// coming from them there is nothing to tell by, as in callConnecting.
export function notConnected(workspaceId: string, userId: number): boolean {
  const current = call();
  if (current?.workspaceId !== workspaceId || !canCarryMedia(workspaceId)) return false;
  if (userId === myId(workspaceId) || voiceChannelOf(workspaceId, userId) !== current.channelId) return false;
  const p = participants(workspaceId, current.channelId).find((m) => m.userId === userId);
  if (p && !audible(workspaceId, p)) return false;
  return !remoteStream(workspaceId, userId, "mic") && !remoteStream(workspaceId, userId, "screen") && !remoteStream(workspaceId, userId, "camera");
}

// How many members a call has: those this device knows of, or more if another member counts more.
export function callSize(workspaceId: string, channelId: number): number {
  return Math.max(participants(workspaceId, channelId).length, reportedCallSize(workspaceId, channelId));
}

// A connect that drags on (a ghost member, a broken path): the label says so instead of a bare "Connecting…".
export const callConnectingLong = connectingLong;

const [speakingRaw, setSpeakingRaw] = createSignal(false);
// Push to talk is transmitting while its key is held, and through the release tail.
export const pttTalking = () => isPushToTalk(inputMode()) && (pttHeld() || pttTail());
// Muting, deafening and a moderator's voice mute all mean the microphone doesn't send.
export const voiceBlocked = () => muted() || deafened() || voiceMutedByModerator();
// What the microphone's track sends right now: voice activation unless muted; push to talk only while talking.
export const transmitting = () => micTransmits({
  mode: inputMode(), muted: voiceBlocked(), deafened: deafened(), talking: pttTalking(),
});
export const speakingSelf = () => transmitting() && speakingRaw();

function failVoice(message: string): void {
  setVoiceError(message);
  playSound("error");
}

// Joins and leaves run one after the other: a call rejoined on start (resumeCall) and a join a moment later ran at
// once, their microphones' chains crossed, and every later leave threw (mesh-test s13).
let voiceSteps: Promise<void> = Promise.resolve();

function voiceStep(step: () => Promise<void>): Promise<void> {
  const run = voiceSteps.then(step, step);
  voiceSteps = run.catch(() => {});
  return run;
}

const unmuted: Readonly<{ muted: boolean; deafened: boolean }> = { muted: false, deafened: false };

// `start`: muted or deafened from the beginning (a rejoin keeps what the user had); a join by click starts with neither.
export async function joinVoice(workspaceId: string, channelId: number, start = unmuted): Promise<void> {
  // Must happen during the click: WebKit keeps audio contexts created later suspended.
  audioContext ??= createAudioContext();
  void audioContext.resume();
  return voiceStep(() => joinNow(workspaceId, channelId, start));
}

async function joinNow(workspaceId: string, channelId: number, start: { muted: boolean; deafened: boolean }): Promise<void> {
  // Already in it (rejoined on start and joined again at once).
  if (isInCall(workspaceId, channelId)) return;
  if (call()) await leaveNow(false);
  if (micTesting()) {
    setMicTesting(false);
    stopMic();
  }
  setMuted(start.muted || start.deafened);
  setDeafened(start.deafened);
  setVoiceError("");
  setCall({ workspaceId, channelId });
  setCallSetup(true);
  setCallConnected(false);
  try {
    await workspaceApi(workspaceId).plugin("voice").call("join", { channel_id: channelId });
  } catch (e) {
    setCall(null);
    setCallSetup(false);
    writeJson(resumeKey, null);
    failVoice(userMessage(e));
    return;
  }
  if (!rejoinStopped) writeJson(resumeKey, { workspaceId, channelId, muted: muted(), deafened: deafened() } satisfies Resume);
  await startMic();
  await pushState();
  setCallSetup(false);
  pushShareQuality();
  void refreshDevices();
  playSound("join");
}

// sound: the user chose to leave (not a switch to another call or a drop), so the call isn't rejoined later.
export async function leaveVoice(sound = true): Promise<void> {
  return voiceStep(() => leaveNow(sound));
}

// The app quits on purpose (core/farewell.ts): like Disconnect, no call is rejoined on the next start, not even one
// whose join is still on its way (it would save itself once joined).
export function stopRejoining(): void {
  rejoinStopped = true;
  writeJson(resumeKey, null);
}

async function leaveNow(sound: boolean): Promise<void> {
  const current = call();
  if (sound) writeJson(resumeKey, null);
  if (current) mediaLink(current.workspaceId)?.setLocal(null, { mic: null, camera: null, screen: null });
  releasePushToTalk(true);
  stopMic();
  stopStream(cameraStream(), setCameraStream);
  stopScreen();
  setCall(null);
  setCallSetup(false);
  setCallConnected(false);
  if (current) {
    try {
      await workspaceApi(current.workspaceId).plugin("voice").call("leave");
    } catch (e) {
      console.warn("Leaving voice failed:", e);
    }
  }
  if (sound) playSound("leave");
}

// Muted in calls by a moderator of the workspace the call is in (others' apps don't play them either).
export const voiceMutedByModerator = () => {
  const current = call();
  const me = current ? myId(current.workspaceId) : null;
  return !!current && me !== null && isMuted(current.workspaceId, me, "voice");
};

createRoot(() => createEffect(() => {
  if (voiceMutedByModerator() && !muted()) {
    setMuted(true);
    applyMute();
    playSound("mute");
    void pushState();
  }
}));

// Connected once: every audible member of the call has arrived (or there is nobody to hear). Kept for the rest of
// the call, so a call-mode switch that re-negotiates media doesn't show the indicator again.
createRoot(() => createEffect(() => {
  const current = call();
  if (!current) return setCallConnected(false);
  if (!canCarryMedia(current.workspaceId)) return;
  if (callConnected() || callSetup()) return;
  const me = myId(current.workspaceId);
  const allHeard = participants(current.workspaceId, current.channelId)
    .filter((p) => p.userId !== me && audible(current.workspaceId, p))
    .every((p) => !!remoteStream(current.workspaceId, p.userId, "mic"));
  if (allHeard) setCallConnected(true);
}));

// After a while still not connected (a ghost member, a broken path), the label says so instead of bare "Connecting…".
let connectingTimer: ReturnType<typeof setTimeout> | undefined;
createRoot(() => createEffect(() => {
  const connecting = callConnecting();
  clearTimeout(connectingTimer);
  connectingTimer = undefined;
  setConnectingLong(false);
  if (connecting) connectingTimer = setTimeout(() => setConnectingLong(true), connectingSlowMs);
}));

// Mute and deafen go into the call to rejoin as they change, so a restart in the middle of a call keeps them.
createRoot(() => createEffect(() => {
  const current = call();
  const state = { muted: muted(), deafened: deafened() };
  if (!current || callSetup()) return;
  const saved = readJson<Resume | null>(resumeKey, null);
  if (saved?.workspaceId === current.workspaceId && saved.channelId === current.channelId) writeJson(resumeKey, { ...saved, ...state });
}));

export function toggleMute(): void {
  if (muted() && voiceMutedByModerator()) {
    failVoice("A moderator muted you in calls on this workspace.");
    return;
  }
  // Joined without a microphone (denied or missing): unmuting asks again.
  if (muted() && !micStream() && call()) {
    void startMic().then(() => {
      if (micStream()) {
        setMuted(false);
        setDeafened(false);
        setVoiceError("");
        applyMute();
        playSound("unmute");
        void pushState();
        void refreshDevices();
      }
    });
    return;
  }
  const wasDeafened = deafened();
  if (wasDeafened) {
    setDeafened(false);
    setMuted(voiceMutedByModerator());
  } else setMuted(!muted());
  applyMute();
  playSound(wasDeafened ? "undeafen" : muted() ? "mute" : "unmute");
  void pushState();
}

export function toggleDeafen(): void {
  const next = !deafened();
  setDeafened(next);
  setMuted(next || voiceMutedByModerator());
  applyMute();
  playSound(next ? "deafen" : "undeafen");
  void pushState();
}

// Set while a camera or screen is being picked, so repeated clicks don't open several prompts.
const [startingCamera, setStartingCamera] = createSignal(false);
const [startingPicture, setStartingPicture] = createSignal(false);
const [startingSound, setStartingSound] = createSignal(false);
export { startingCamera, startingPicture, startingSound };

export async function toggleCamera(): Promise<void> {
  if (startingCamera()) return;
  if (cameraStream()) {
    stopStream(cameraStream(), setCameraStream);
    playSound("stream-stop");
  } else {
    setStartingCamera(true);
    try {
      const stream = await openCamera();
      // Left the call while the prompt was open.
      if (!call()) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      setCameraStream(stream);
      setVoiceError("");
      playSound("stream-start");
    } catch (e) {
      failVoice(mediaError(e, "Camera"));
    } finally {
      setStartingCamera(false);
    }
  }
  void pushState();
}

// The chosen camera, else the system's default (also when the chosen one is unplugged).
async function openCamera(): Promise<MediaStream> {
  const id = cameraId();
  if (id) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id } } });
    } catch (e) {
      const name = (e as DOMException).name;
      if (name !== "OverconstrainedError" && name !== "NotFoundError") throw e;
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: true });
}

// A camera that is on switches over at once.
export async function setCameraDevice(id: string): Promise<void> {
  setCameraIdSignal(id);
  writeJson("mw.voice.camera", id);
  const old = cameraStream();
  if (!old || startingCamera()) return;
  setStartingCamera(true);
  try {
    const stream = await openCamera();
    if (cameraStream() !== old) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    old.getTracks().forEach((t) => t.stop());
    setCameraStream(stream);
    void pushState();
  } catch (e) {
    failVoice(mediaError(e, "Camera"));
  } finally {
    setStartingCamera(false);
  }
}

let pickerCancelledAt = -Infinity;
desktop?.onScreenShareCancelled?.(() => (pickerCancelledAt = performance.now()));

// Screens and windows for the app's own picker; null where the system or browser shows its own.
export async function screenSources(): Promise<ScreenSource[] | null> {
  return (await desktop?.screenSources?.()) ?? null;
}

// Windows records the whole system sound; Linux needs the virtual source, browsers share a tab's sound.
export const canShareSound = desktop ? desktop.platform === "win32" || desktop.platform === "linux" : supportsScreenShare;

// A share is a picture (screen or window) and the system's sound, each switched on and off by itself. Others get
// both as one stream (`screenStream`), made again whenever either changes.
const [picture, setPicture] = createSignal<MediaStream | null>(null);
const [sound, setSound] = createSignal<MediaStream | null>(null);
export { picture as sharedPicture, sound as sharedSound };
// The picker's id of the screen or window being shared; null when it was picked another way.
const [pictureSource, setPictureSource] = createSignal<string | null>(null);
export { pictureSource as sharedSource };

function updateShare() {
  const tracks = [...(picture()?.getTracks() ?? []), ...(sound()?.getTracks() ?? [])];
  setScreenStream(tracks.length > 0 ? new MediaStream(tracks) : null);
  updateSoundAnalyser();
  void pushState();
  pushShareQuality();
}

// Each start can be given up by clicking again (a system picker or audio service that never answers would
// otherwise leave the button waiting); what it brings later is then stopped.
let pictureAttempt = 0;
let soundAttempt = 0;

// `replace`: switches a running share to another screen or window; the old one keeps going until the new one is picked.
export async function togglePicture(source?: string, replace = false): Promise<void> {
  if (!replace && (startingPicture() || picture())) {
    pictureAttempt++;
    setStartingPicture(false);
    if (picture()) stopPicture();
    return;
  }
  if (!call()) return;
  const attempt = ++pictureAttempt;
  setStartingPicture(true);
  try {
    if (source) await desktop?.chooseScreenSource?.(source, false);
    // The size and rate come from the share's quality (voice/shareQuality.ts).
    console.info("Screen share: asking for a picture");
    const quality = shareQuality();
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: captureConstraints(quality), audio: false });
    console.info("Screen share track", stream.getVideoTracks().map((t) => ({ label: t.label, settings: t.getSettings() })));
    const track = stream.getVideoTracks()[0];
    if (attempt !== pictureAttempt || !call() || track?.readyState !== "live") {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    // Now that the screen's shape is known, its box; and the quality as it is now (it may have changed while the
    // picker was open).
    applyCapture(track, shareQuality());
    // Ends when the user stops sharing from the browser or system UI too.
    track.addEventListener("ended", () => picture() === stream && stopSharing());
    picture()?.getTracks().forEach((t) => t.stop());
    setPicture(stream);
    setPictureSource(source ?? null);
    setVoiceError("");
    if (!replace) playSound("stream-start");
    updateShare();
  } catch (e) {
    if (attempt === pictureAttempt && !cancelled(e)) failVoice(mediaError(e, "Screen sharing"));
  } finally {
    if (attempt === pictureAttempt) setStartingPicture(false);
  }
}

export async function toggleSound(): Promise<void> {
  if (startingSound() || sound()) {
    soundAttempt++;
    setStartingSound(false);
    if (sound()) stopSound();
    else void desktop?.shareAudio?.stop();
    return;
  }
  if (!call()) return;
  const attempt = ++soundAttempt;
  setStartingSound(true);
  try {
    console.info("Screen share: asking for sound");
    const stream = await captureSound();
    const track = stream?.getAudioTracks()[0];
    if (!stream || attempt !== soundAttempt || !call() || track?.readyState !== "live") {
      stream?.getTracks().forEach((t) => t.stop());
      if (stream && desktop?.platform === "linux") void desktop.shareAudio?.stop();
      return;
    }
    track.addEventListener("ended", () => sound() === stream && stopSound());
    setSound(stream);
    setVoiceError("");
    if (!picture()) playSound("stream-start");
    updateShare();
  } catch (e) {
    if (attempt === soundAttempt && !cancelled(e)) failVoice(mediaError(e, "Sharing sound"));
  } finally {
    if (attempt === soundAttempt) setStartingSound(false);
  }
}

// Stops the picture and the sound that goes with it, also one that is still starting.
export function stopSharing() {
  pictureAttempt++;
  soundAttempt++;
  setStartingPicture(false);
  setStartingSound(false);
  if (sound()) stopSound();
  else void desktop?.shareAudio?.stop();
  if (picture()) stopPicture();
}

function stopPicture() {
  picture()?.getTracks().forEach((t) => t.stop());
  setPicture(null);
  setPictureSource(null);
  playSound("stream-stop");
  updateShare();
}

function stopSound() {
  sound()?.getTracks().forEach((t) => t.stop());
  setSound(null);
  void desktop?.shareAudio?.stop();
  if (!picture()) playSound("stream-stop");
  updateShare();
}

const cancelled = (e: unknown) => (e as DOMException).name === "NotAllowedError" || (e as DOMException).name === "AbortError"
  || performance.now() - pickerCancelledAt < 2000;

// The app's own sound (the call, others' shares) is left out, or others would hear themselves. Electron honors this
// on Windows and macOS since 43.4; Linux uses the virtual source, which leaves this app out itself.
const displaySound = { restrictOwnAudio: true, suppressLocalAudioPlayback: false } as MediaTrackConstraints;

// The system's sound alone: the Linux virtual source, else a screen capture's sound without its picture.
async function captureSound(): Promise<MediaStream | null> {
  if (desktop?.platform === "linux") return systemAudio();
  const capture = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: displaySound });
  capture.getVideoTracks().forEach((t) => t.stop());
  const audio = capture.getAudioTracks();
  if (audio.length === 0) {
    failVoice(desktop ? "This system can't share its sound." : "No sound was shared. Pick a tab and turn on its sound.");
    return null;
  }
  return new MediaStream(audio);
}

// The virtual source's name (electron/shareAudio.js), kept out of the microphone list.
const screenAudioLabel = "MakeWork screen audio";

// Linux desktop: Chromium's own loopback would send the call back to everyone, so other apps' sound comes from a
// virtual source the main process fills (electron/shareAudio.js).
async function systemAudio(): Promise<MediaStream | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000));
  try {
    if (!(await Promise.race([desktop!.shareAudio!.start(), timeout]))) {
      failVoice("Sharing sound needs PipeWire on Linux, and it didn't answer.");
      return null;
    }
    // A new source takes a moment to show up in the device list.
    let device: MediaDeviceInfo | undefined;
    for (let tries = 0; !device && tries < 10; tries++) {
      if (tries) await new Promise((r) => setTimeout(r, 200));
      device = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audioinput" && d.label === screenAudioLabel);
    }
    if (!device) throw new Error(`"${screenAudioLabel}" isn't listed`);
    return await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: device.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    });
  } catch (e) {
    console.warn("Screen share audio not added:", e);
    void desktop!.shareAudio!.stop();
    failVoice("The computer's sound couldn't be shared.");
    return null;
  }
}

// Stops the whole share (leaving the call).
function stopScreen() {
  pictureAttempt++;
  soundAttempt++;
  setStartingPicture(false);
  setStartingSound(false);
  picture()?.getTracks().forEach((t) => t.stop());
  sound()?.getTracks().forEach((t) => t.stop());
  setPicture(null);
  setPictureSource(null);
  setSound(null);
  setScreenStream(null);
  updateSoundAnalyser();
  void desktop?.shareAudio?.stop();
}

// Your shared sound, measured for the visualizer.
let soundAnalyser: { node: AnalyserNode; stop: () => void } | null = null;
const [ownAnalyser, setOwnAnalyser] = createSignal<AnalyserNode | null>(null);

function updateSoundAnalyser() {
  const stream = sound();
  soundAnalyser?.stop();
  soundAnalyser = null;
  if (stream && audioContext) {
    const source = audioContext.createMediaStreamSource(stream);
    const node = audioContext.createAnalyser();
    node.fftSize = 512;
    // WebKit only feeds an analyser that reaches the output, so route it there silenced.
    const silence = audioContext.createGain();
    silence.gain.value = 0;
    source.connect(node);
    node.connect(silence);
    silence.connect(audioContext.destination);
    soundAnalyser = { node, stop: () => [source, node, silence].forEach((n) => n.disconnect()) };
  }
  setOwnAnalyser(soundAnalyser?.node ?? null);
}

// What a member's shared sound looks like right now, for the visualizer; undefined while it doesn't play here.
export function sharedSoundAnalyser(workspaceId: string, userId: number): AnalyserNode | undefined {
  return userId === myId(workspaceId) ? ownAnalyser() ?? undefined : remoteAnalyser(`${workspaceId}:${userId}:screen`);
}

export function isSoundOnly(stream: MediaStream | null): boolean {
  return !!stream && stream.getVideoTracks().length === 0;
}

// Electron labels captures with their source id ("screen:0:0", "window:123:0").
export function sharingLabel(stream: MediaStream | null): string | null {
  if (!stream) return null;
  if (isSoundOnly(stream)) return "Sound";
  const label = stream.getVideoTracks()[0]?.label ?? "";
  if (!label || label.startsWith("screen:")) return "Screen";
  if (label.startsWith("window:")) return "A window";
  return label;
}

export async function setInputDevice(id: string): Promise<void> {
  setInputIdSignal(id);
  writeJson("mw.voice.input", id);
  setSpeechDb(speechTargetDb);
  if (call() || micTesting()) await restartMic();
}

export function setOutputDevice(id: string): void {
  setOutputIdSignal(id);
  writeJson("mw.voice.output", id);
}

export async function refreshDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  setInputs(devices.filter((d) => d.kind === "audioinput" && d.label !== screenAudioLabel));
  setOutputs(devices.filter((d) => d.kind === "audiooutput"));
  setCameras(devices.filter((d) => d.kind === "videoinput"));
}

if (typeof navigator !== "undefined") navigator.mediaDevices?.addEventListener?.("devicechange", () => void refreshDevices());

async function startMic() {
  try {
    const audio: MediaTrackConstraints = {
      // Off: the browser's gain control turns the mic up while nobody speaks, and the send chain below
      // already brings speech to level.
      echoCancellation: true, noiseSuppression: noiseSuppression() !== "off", autoGainControl: false,
      ...(inputId() ? { deviceId: { exact: inputId() } } : {}),
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    setMicStream(stream);
    applyMute();
    const input = await startMicInput(stream);
    const processor = await createMicNode(input.context as AudioContext);
    // Stopped (left the call, another restart) while that loaded.
    if (micStream() !== stream) return processor?.disconnect();
    startMicSend(input, processor);
    startMeter(input, processor);
    shareMedia();
  } catch (e) {
    setMuted(true);
    failVoice(`${mediaError(e, "Microphone")} You joined muted.`);
  }
}

function applyMute() {
  for (const track of micStream()?.getAudioTracks() ?? []) track.enabled = transmitting();
}

function shareMedia() {
  const current = call();
  if (current) mediaLink(current.workspaceId)?.setLocal(current.channelId, {
    mic: micSend?.stream ?? micStream(), camera: cameraStream(), screen: screenStream(),
  });
}

// What others hear: the microphone through the mic processor (micProcessing.ts, an AudioWorklet: brought to
// speech level automatically, then a noise gate that closes while nobody speaks), then the user's mic volume (past
// 100% too), then a limiter so the boost doesn't clip. Muting disables the microphone's own tracks, which silences
// this too. Without AudioWorklets (insecure pages) the mic goes out with a fixed gain and no gate.
let micSend: { stream: MediaStream; gain: GainNode; processor: AudioWorkletNode | null; stop: () => void } | null = null;

// The speech level the processor measured, kept for the next call with the same mic.
let speechDb = readJson("mw.voice.speechDb", speechTargetDb);

function setSpeechDb(db: number) {
  speechDb = db;
  writeJson("mw.voice.speechDb", db);
}

const micWorkletLoaded = new WeakSet<BaseAudioContext>();

// A load that never answers must not hold the join: the call falls back to the plainer microphone path.
const micLoadMs = 5000;

function within<T>(work: Promise<T>, what: string): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took too long`)), micLoadMs))]);
}

async function createMicNode(context: AudioContext): Promise<AudioWorkletNode | null> {
  try {
    if (!micWorkletLoaded.has(context)) {
      await within(context.audioWorklet.addModule(micWorkletUrl), "Loading the microphone processor");
      micWorkletLoaded.add(context);
    }
    return new AudioWorkletNode(context, "mw-mic", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit",
      processorOptions: { threshold: sensitivityDb(), speechDb },
    });
  } catch (e) {
    console.warn("Microphone processing isn't available; sending the microphone without a gate:", e);
    return null;
  }
}

function startMicSend(input: AudioNode, processor: AudioWorkletNode | null) {
  stopMicSend();
  const context = input.context as AudioContext;
  const fixed = processor ? null : context.createGain();
  if (fixed) fixed.gain.value = 10 ** (autoGainDbFor(speechDb) / 20);
  const first = processor ?? fixed!;
  const gain = context.createGain();
  gain.gain.value = micVolume();
  const limiter = createLimiter(context);
  const destination = context.createMediaStreamDestination();
  input.connect(first);
  first.connect(gain);
  gain.connect(limiter);
  limiter.connect(destination);
  micSend = {
    stream: destination.stream, gain, processor,
    stop: () => {
      disconnectQuietly(() => input.disconnect(first), () => first.disconnect(), () => gain.disconnect(), () => limiter.disconnect());
      destination.stream.getTracks().forEach((t) => t.stop());
    },
  };
  // A restart (device change) while the key is held keeps the gate open.
  pushMicGate();
}

function pushMicGate() {
  postMic({ ptt: isPushToTalk(inputMode()) && pttTalking() });
}

// The microphone worklet takes messages on its port.
function postMic(message: { threshold?: number | null; ptt?: boolean }) {
  micSend?.processor?.port.postMessage(message);
}

function stopMicSend() {
  const send = micSend;
  micSend = null;
  send?.stop();
}

// Takes audio nodes apart without throwing. Disconnecting from a node it no longer feeds throws (a restart stops the old
// input first): the old chain stayed, and every later leave threw with it (mesh-test s13).
function disconnectQuietly(...steps: (() => void)[]): void {
  for (const step of steps) {
    try {
      step();
    } catch {
      // Not connected any more.
    }
  }
}

createRoot(() => createEffect(() => {
  const volume = micVolume();
  if (micSend) micSend.gain.gain.value = volume;
}));

createRoot(() => createEffect(() => {
  const threshold = sensitivityDb();
  postMic({ threshold });
}));

// The microphone's track and its gate follow the input mode, the push-to-talk key (and its tail) and mute/deafen.
createRoot(() => createEffect(() => {
  applyMute();
  pushMicGate();
}));

async function pushState() {
  const current = call();
  if (!current) return;
  shareMedia();
  try {
    await workspaceApi(current.workspaceId).plugin("voice").call("set-state", {
      muted: muted(), deafened: deafened(), sharing: sharingLabel(screenStream()),
      sound_only: isSoundOnly(screenStream()), camera: cameraStream() !== null,
    });
  } catch (e) {
    console.warn("Voice state not sent:", e);
  }
}

function stopStream(stream: MediaStream | null, set: (s: null) => void) {
  stream?.getTracks().forEach((t) => t.stop());
  set(null);
}

function mediaError(e: unknown, what: string): string {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError") return `${what} access was denied.`;
  if (name === "NotFoundError") return `No ${what.toLowerCase()} found.`;
  return `${what} is not available here.`;
}

let audioContext: AudioContext | undefined;

// The level in the indicators' steps (levels.ts), so a mic message that changes nothing visible draws nothing.
function showMic(state: { db: number; level: number; speaking: boolean }) {
  setLevel(stepLevel(state.level));
  setMicDb(state.db);
  setSpeakingRaw(state.speaking);
  // Talking keeps this member from turning away, as input does.
  if (state.speaking && transmitting()) markActive();
}

// The level, the speaking dot and the sensitivity meter. Only for showing: what is sent never waits on this, as
// animation frames and timers stop or slow down while the window is hidden.
function startMeter(input: AudioNode, processor: AudioWorkletNode | null) {
  stopMeter();
  const context = input.context as AudioContext;
  void context.resume();
  // WebKit only runs nodes that reach the output, so route the meter's node there silenced.
  const silence = context.createGain();
  silence.gain.value = 0;
  silence.connect(context.destination);
  const started = performance.now();
  let loudestDb = -Infinity;
  let reported = false;
  let loggedGainDb: number | null = null;
  const check = (state: { db: number; floorDb?: number; gainDb: number }) => {
    loudestDb = Math.max(loudestDb, state.db);
    if (!reported && performance.now() - started > 3000) {
      reported = true;
      loggedGainDb = state.gainDb;
      console.info("Mic level check", {
        loudestDb, floorDb: state.floorDb, speechDb, autoGainDb: state.gainDb, processor: !!processor,
        contextState: context.state, sampleRate: context.sampleRate,
      });
    }
    // For reports of a quiet voice: big gain changes are rare by design.
    if (loggedGainDb !== null && Math.abs(state.gainDb - loggedGainDb) >= 10) {
      console.info("Mic gain changed", { from: loggedGainDb, to: state.gainDb, speechDb });
      loggedGainDb = state.gainDb;
    }
  };

  if (processor) {
    processor.connect(silence);
    processor.port.onmessage = (event: MessageEvent<MicState>) => {
      speechDb = event.data.speechDb;
      showMic(event.data);
      check(event.data);
    };
    meterRunning = true;
    stopSource = () => {
      processor.port.onmessage = null;
      silence.disconnect();
    };
    return;
  }

  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  input.connect(analyser);
  analyser.connect(silence);
  const samples = new Float32Array(analyser.fftSize);
  const detector = createSpeakingDetector(sensitivityDb);
  let lastSet = 0;
  const tick = (time: number) => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    const db = 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
    const state = detector.update(db, time);
    check({ db, floorDb: detector.floorDb(), gainDb: autoGainDbFor(speechDb) });
    if (time - lastSet > 60) {
      showMic({ db, ...state });
      lastSet = time;
    }
    meterFrame = requestAnimationFrame(tick);
  };
  meterFrame = requestAnimationFrame(tick);
  meterRunning = true;
  stopSource = () => {
    if (meterFrame !== undefined) cancelAnimationFrame(meterFrame);
    meterFrame = undefined;
    disconnectQuietly(() => input.disconnect(analyser), () => analyser.disconnect(), () => silence.disconnect());
  };
}

let meterFrame: number | undefined;
let meterRunning = false;
let stopSource: (() => void) | undefined;

function stopMeter() {
  if (meterRunning) setSpeechDb(speechDb);
  meterRunning = false;
  const stop = stopSource;
  stopSource = undefined;
  stop?.();
  setLevel(0);
  setMicDb(-Infinity);
  setSpeakingRaw(false);
}

// RNNoise needs 48 kHz; any rate works for everything else.
function createAudioContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: 48000 });
  } catch {
    return new AudioContext();
  }
}

// The microphone after noise suppression, which both the meter and what others hear read from.
let micInput: { node: AudioNode; stop: () => void } | null = null;

async function startMicInput(stream: MediaStream): Promise<AudioNode> {
  micInput?.stop();
  const context = (audioContext ??= createAudioContext());
  const source = context.createMediaStreamSource(stream);
  let suppressor: (AudioNode & { destroy(): void }) | null = null;
  if (noiseSuppression() === "strong") {
    try {
      suppressor = await within(createSuppressor(context), "Loading the noise suppressor");
      source.connect(suppressor);
    } catch (e) {
      console.warn("Strong noise suppression not available:", e);
      setVoiceError("Strong noise suppression isn't available here; using standard.");
    }
  }
  micInput = {
    node: suppressor ?? source,
    stop: () => {
      source.disconnect();
      suppressor?.disconnect();
      suppressor?.destroy();
    },
  };
  return micInput.node;
}

function stopMic() {
  stopMicSend();
  stopMeter();
  micInput?.stop();
  micInput = null;
  stopStream(micStream(), setMicStream);
}

async function restartMic() {
  stopMic();
  await startMic();
}

// The microphone's level in dBFS (after noise suppression), for the sensitivity setting.
const [micDb, setMicDb] = createSignal(-Infinity);
export { micDb };

// Trying the microphone outside a call, from Settings > Audio.
const [micTesting, setMicTesting] = createSignal(false);
export { micTesting };

export async function toggleMicTest(): Promise<void> {
  if (micTesting()) {
    releasePushToTalk(true);
    setMicTesting(false);
    if (!call()) stopMic();
    return;
  }
  if (call()) return;
  // Created during the click, like joinVoice.
  audioContext ??= createAudioContext();
  void audioContext.resume();
  setMicTesting(true);
  await startMic();
  if (!micStream()) setMicTesting(false);
}

createRoot(() => createEffect(on(noiseSuppression, () => {
  if (micStream()) void restartMic();
}, { defer: true })));

// Push to talk: holding the key opens the microphone and its gate; releasing it keeps them on for a short tail, so
// the last syllable isn't cut. Works while the window has focus (the desktop app included); a missed key-up (the
// window losing focus) releases at once.
let pttHeldCode: string | null = null;
let pttReleaseTimer: ReturnType<typeof setTimeout> | undefined;

function clearPttTail(): void {
  clearTimeout(pttReleaseTimer);
  pttReleaseTimer = undefined;
  setPttTail(false);
}

function releasePushToTalk(immediate = false): void {
  pttHeldCode = null;
  setPttHeld(false);
  clearTimeout(pttReleaseTimer);
  pttReleaseTimer = undefined;
  if (immediate) {
    setPttTail(false);
    return;
  }
  setPttTail(true);
  pttReleaseTimer = setTimeout(() => {
    pttReleaseTimer = undefined;
    setPttTail(false);
  }, pttReleaseMs);
}

function onPttKeyDown(e: KeyboardEvent): void {
  if (capturingPttKey() || e.repeat || pttHeldCode !== null) return;
  if (!isPushToTalk(inputMode()) || !matchesPttKey(e, pttKey())) return;
  if (!call() && !micTesting()) return;
  // Keeps the bound key from typing into a field or, for F8, toggling Firefox's caret browsing.
  e.preventDefault();
  clearPttTail();
  pttHeldCode = e.code;
  setPttHeld(true);
  // Joined without a microphone (denied or missing): holding the key asks again, like unmuting does.
  if (muted() && !micStream() && call() && !deafened() && !voiceMutedByModerator()) {
    void startMic().then(() => {
      if (micStream()) {
        setMuted(false);
        setDeafened(false);
        setVoiceError("");
        void pushState();
        void refreshDevices();
      }
    });
  }
}

function onPttKeyUp(e: KeyboardEvent): void {
  // The modifiers may be released before the key itself: match on the code alone.
  if (pttHeldCode === null || e.code !== pttHeldCode) return;
  releasePushToTalk();
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", onPttKeyDown, true);
  window.addEventListener("keyup", onPttKeyUp, true);
  window.addEventListener("blur", () => releasePushToTalk(true));
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") releasePushToTalk(true);
  });
}

// Switching back to voice activation while the key is down stops transmitting at once.
createRoot(() => createEffect(on(inputMode, (mode) => {
  if (!isPushToTalk(mode)) releasePushToTalk(true);
}, { defer: true })));

// Other members' microphones and shared sound play while we are in a call with them, whatever is shown (in a mesh call
// a share's sound comes on its own while this device doesn't view its picture, ADR 0019).
createRoot(() => createEffect(() => {
  const current = call();
  const people = current ? participants(current.workspaceId, current.channelId) : [];
  const together = new Set(people.map((p) => p.userId));
  for (const p of people) {
    const who = current && member(current.workspaceId, p.userId);
    const quiet = who?.bot ? botTypeFor(who.botType)?.type.defaultVolume : undefined;
    if (quiet !== undefined) setDefaultVolume(p.userId, quiet);
  }
  // Voice-muted members aren't played (or shown speaking), whatever their own app sends.
  const heard = (userId: number) => !!current && together.has(userId) && !isMuted(current.workspaceId, userId, "voice");
  const wanted = current
    ? [
      ...remoteMics(current.workspaceId).filter((m) => heard(m.userId))
        .map((m) => ({ key: `${current.workspaceId}:${m.userId}`, stream: m.stream, volume: isLocallyMuted(m.userId) ? 0 : userVolume(m.userId) * outputVolume() })),
      ...people.filter((p) => p.sharing && heard(p.userId)).flatMap((p) => {
        const stream = remoteStream(current.workspaceId, p.userId, "screen");
        return stream && stream.getAudioTracks().length > 0
          ? [{ key: `${current.workspaceId}:${p.userId}:screen`, stream, volume: streamVolume(p.userId) * outputVolume() }]
          : [];
      }),
    ]
    : [];
  playRemote(wanted, { context: audioContext, deafened: deafened(), safety: loudnessSafety(), outputId: outputId(), onOutputError: failVoice });
}));

// How loud someone speaking is, 0 to 1; 0 when they are not speaking.
export function speakingLevel(workspaceId: string, userId: number): number {
  if (!isSpeaking(workspaceId, userId)) return 0;
  return userId === myId(workspaceId) ? level() : remoteLevel(`${workspaceId}:${userId}`);
}

export function isSpeaking(workspaceId: string, userId: number): boolean {
  if (userId === myId(workspaceId)) return call()?.workspaceId === workspaceId && speakingSelf();
  const p = (presence[workspaceId] ?? []).find((x) => x.userId === userId);
  return !!p && !p.muted && isRemoteSpeaking(`${workspaceId}:${userId}`);
}
