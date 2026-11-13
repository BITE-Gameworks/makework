// Plays other members' microphones and tells when they speak. Sound goes through Web Audio (stream -> gain ->
// loudness guard (loudness.ts) -> limiter -> output), so volumes can go above 100% and the output device is chosen on the audio context. Each player
// is also attached to a muted media element: Chromium only delivers a remote WebRTC stream to Web Audio
// while an element plays it.
// A player plays one track. A remote stream's tracks can change under the same object (its sender placed it again),
// and Web Audio keeps the track a stream had when the source was made: a player per stream went on playing the old,
// silent track ("muted by the connection" in call diagnostics).
import { batch, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { noteActivity } from "./activity";
import { createSpeakingDetector, stepLevel } from "./levels";
import { micTrack } from "./health";
import loudnessWorkletUrl from "./loudnessWorklet.ts?worker&url";


interface Player {
  element: HTMLAudioElement;
  gain: GainNode;
  guard: () => AudioWorkletNode | null;
  setVolume: (volume: number, safety: boolean) => void;
  analyser: AnalyserNode;
  stream: MediaStream;
  levelDb: () => number;
  measure: () => void;
  stop: () => void;
}

const players = new Map<string, Player>();
// Track ids repeat when the same sender's track arrives a second way (through a go-between, then directly), so
// players are told apart by the track object.
const trackNumbers = new WeakMap<MediaStreamTrack, number>();
let trackCount = 0;

function playerId(key: string, track: MediaStreamTrack): string {
  let number = trackNumbers.get(track);
  if (number === undefined) trackNumbers.set(track, (number = ++trackCount));
  return `${key}|${number}`;
}

// The track to play: a live one getting sound if there is one, the newest first.
export const playableTrack = micTrack;
// All call audio meets here before the speakers, so boosted voices are limited instead of clipping harshly.
const limiters = new WeakMap<AudioContext, DynamicsCompressorNode>();

function limiter(context: AudioContext): DynamicsCompressorNode {
  let node = limiters.get(context);
  if (!node) {
    node = createLimiter(context);
    node.connect(context.destination);
    limiters.set(context, node);
  }
  return node;
}

// The loudness guard's processor, loaded once per audio context; false when it can't be.
const guardModules = new WeakMap<AudioContext, Promise<boolean>>();
function loadGuard(context: AudioContext): Promise<boolean> {
  let loading = guardModules.get(context);
  if (!loading) {
    loading = Promise.race([
      context.audioWorklet.addModule(loudnessWorkletUrl).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]).catch((e) => {
      console.warn("Loudness guard isn't available:", e);
      return false;
    });
    guardModules.set(context, loading);
  }
  return loading;
}

// Holds peaks just under full scale; also guards the boosted microphone before it is sent.
export function createLimiter(context: BaseAudioContext): DynamicsCompressorNode {
  const node = context.createDynamicsCompressor();
  node.threshold.value = -3;
  node.knee.value = 0;
  node.ratio.value = 20;
  node.attack.value = 0.003;
  node.release.value = 0.1;
  return node;
}
// Per speaker, so one starting or stopping re-runs only their own dots and names (mesh-test s14: with one set for
// everyone, every change re-ran every indicator in the app).
const [speaking, setSpeaking] = createStore<Record<string, boolean>>({});
// How loud each speaker is while speaking, in steps (stepLevel), from the speaking threshold up 30 dB; 0 in silence.
const [levels, setLevels] = createStore<Record<string, number>>({});
// Changes when a player starts or stops, for visualizers waiting for a stream's analyser.
const [playersChanged, setPlayersChanged] = createSignal(0);
// One timer measures every player, their changes going to the page at once: each change makes the page draw, so it
// is sparse on purpose.
const measureMs = 100;
let meter: ReturnType<typeof setInterval> | undefined;
let sinkId = "";

export function isRemoteSpeaking(key: string): boolean {
  return speaking[key] ?? false;
}

export function remoteLevel(key: string): number {
  return levels[key] ?? 0;
}

// The playing stream's analyser, read by visualizers; reactive, so it shows up once playing.
export function remoteAnalyser(key: string): AnalyserNode | undefined {
  void playersChanged();
  return [...players.entries()].find(([id]) => id.startsWith(`${key}|`))?.[1].analyser;
}

// Keeps exactly one player per wanted stream; `key` names the speaker for isRemoteSpeaking.
export function playRemote(wanted: { key: string; stream: MediaStream; volume: number }[], options: {
  context: AudioContext | undefined;
  deafened: boolean;
  // The loudness guard (Settings > Audio).
  safety: boolean;
  outputId: string;
  onOutputError: (message: string) => void;
}): void {
  const playing = wanted.flatMap((w) => {
    const track = playableTrack(w.stream);
    return track ? [{ ...w, track }] : [];
  });
  const keep = new Set(playing.map((w) => playerId(w.key, w.track)));
  for (const [id, player] of players)
    if (!keep.has(id)) {
      player.stop();
      players.delete(id);
      setPlayersChanged((n) => n + 1);
    }
  const context = options.context;
  if (context) startPlayers(playing, context, options);
  if (players.size && !meter) meter = setInterval(() => batch(() => players.forEach((p) => p.measure())), measureMs);
  if (!players.size && meter) {
    clearInterval(meter);
    meter = undefined;
  }
}

function startPlayers(wanted: { key: string; track: MediaStreamTrack; volume: number }[], context: AudioContext, options: {
  deafened: boolean;
  safety: boolean;
  outputId: string;
  onOutputError: (message: string) => void;
}): void {
  if (context.state === "suspended") void context.resume();
  setOutput(context, options.outputId, options.onOutputError);
  for (const { key, track, volume } of wanted) {
    const id = playerId(key, track);
    let player = players.get(id);
    if (!player) {
      player = start(key, new MediaStream([track]), context);
      players.set(id, player);
      setPlayersChanged((n) => n + 1);
    }
    player.setVolume(options.deafened ? 0 : volume, options.safety);
  }
}

function setOutput(context: AudioContext, outputId: string, onError: (message: string) => void) {
  const withSink = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (!withSink.setSinkId || sinkId === outputId) return;
  sinkId = outputId;
  withSink.setSinkId(outputId).catch((e) => {
    console.warn("Output device not set:", e);
    sinkId = "";
    void withSink.setSinkId!("").catch(() => {});
    onError("The chosen output device can't be used; sound plays on the system default.");
  });
}

// The output device's name, for diagnostics.
async function outputName(id: string): Promise<string> {
  if (!id) return "System default";
  const devices = await navigator.mediaDevices?.enumerateDevices?.() ?? [];
  return devices.find((d) => d.kind === "audiooutput" && d.deviceId === id)?.label || `unknown device (${id.slice(0, 8)}...)`;
}

function start(key: string, stream: MediaStream, context: AudioContext): Player {
  noteActivity("players started");
  const element = new Audio();
  element.muted = true;
  element.srcObject = stream;
  void element.play().catch(() => {});

  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(gain);
  gain.connect(limiter(context));
  source.connect(analyser);
  // Until the guard is in place, with the guard on, nothing plays boosted.
  let guard: AudioWorkletNode | null = null;
  let stopped = false;
  let volume = 1;
  let safety = true;
  const setVolume = (next: number, on: boolean) => {
    volume = next;
    safety = on;
    gain.gain.value = guard || !on ? next : Math.min(next, 1);
    guard?.port.postMessage({ boost: next, on });
  };
  void loadGuard(context).then((ok) => {
    if (!ok || stopped) return;
    guard = new AudioWorkletNode(context, "mw-loudness", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    gain.disconnect();
    gain.connect(guard);
    guard.connect(limiter(context));
    setVolume(volume, safety);
  });

  const samples = new Float32Array(analyser.fftSize);
  const levelDb = () => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    return 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
  };
  const detector = createSpeakingDetector();

  return {
    element, gain, analyser, stream, levelDb, setVolume, guard: () => guard,
    measure: () => {
      const state = detector.update(levelDb(), performance.now());
      mark(key, state.speaking);
      const level = state.speaking ? stepLevel(state.level) : 0;
      if ((levels[key] ?? 0) !== level) setLevels(key, level);
    },
    stop: () => {
      stopped = true;
      source.disconnect();
      gain.disconnect();
      guard?.disconnect();
      analyser.disconnect();
      element.srcObject = null;
      mark(key, false);
      setLevels(key, 0);
    },
  };
}

function mark(key: string, on: boolean) {
  if ((speaking[key] ?? false) !== on) setSpeaking(key, on);
}

// What happens to a member's sound on this device, for call diagnostics.
export async function playbackInfo(key: string): Promise<Record<string, string | number | boolean> | null> {
  const player = [...players.entries()].find(([id]) => id.startsWith(`${key}|`))?.[1];
  if (!player) return null;
  const context = player.gain.context as AudioContext & { sinkId?: string };
  const track = player.stream.getAudioTracks()[0];
  return {
    "Audio engine": context.state,
    "Output device": await outputName(context.sinkId ?? ""),
    "Volume (gain)": player.gain.gain.value,
    "Loudness guard": player.guard() ? "in place" : "not loaded",
    "Level arriving (dB)": Math.round(player.levelDb()),
    "Track": track ? `${track.readyState}${track.muted ? ", muted by the connection" : ""}${track.enabled ? "" : ", disabled"}` : "none",
    "Helper element playing": !player.element.paused,
  };
}
