// System audio for screen sharing on Linux. Chromium's loopback records the whole output, the call included, so
// others would hear themselves. Instead a virtual source (a PipeWire null sink shown as a microphone) gets every
// app's playback linked into it except this app's own, and the page records that source. Needs PipeWire (pactl
// through pipewire-pulse, pw-dump, pw-link). Everything is removed again when sharing stops.
import { app } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
// A PipeWire that stopped answering must not leave sharing waiting.
const run = (command, args, options = {}) => exec(command, args, { timeout: 5000, ...options });
const sinkName = "makework_screen_audio";
export const shareAudioLabel = "MakeWork screen audio";

let moduleId = null;
let timer = null;
let linking = false;

export async function startShareAudio() {
  if (process.platform !== "linux") return null;
  if (moduleId !== null) return shareAudioLabel;
  try {
    await unloadLeftovers();
    const { stdout } = await run("pactl", [
      "load-module", "module-null-sink", "media.class=Audio/Source/Virtual", `sink_name=${sinkName}`,
      `sink_properties='device.description="${shareAudioLabel}"'`, "channel_map=front-left,front-right",
    ]);
    moduleId = stdout.trim();
    await linkApps();
    timer = setInterval(() => void linkApps(), 1500);
    return shareAudioLabel;
  } catch (e) {
    console.warn("Screen share audio unavailable:", e.message);
    stopShareAudio();
    return null;
  }
}

export function stopShareAudio() {
  clearInterval(timer);
  timer = null;
  if (moduleId === null) return;
  try {
    execFileSync("pactl", ["unload-module", moduleId], { timeout: 3000 });
  } catch (e) {
    console.warn("Screen share audio not removed:", e.message);
  }
  moduleId = null;
}

// A source left behind by a crash.
async function unloadLeftovers() {
  const { stdout } = await run("pactl", ["list", "short", "modules"]);
  for (const line of stdout.split("\n")) {
    if (line.includes(`sink_name=${sinkName}`)) await run("pactl", ["unload-module", line.split("\t")[0]]).catch(() => {});
  }
}

const left = new Set(["FL", "RL", "SL"]);
const right = new Set(["FR", "RR", "SR"]);
const both = new Set(["MONO", "FC"]);

// Links each playing app's output ports to the source's matching inputs, once.
async function linkApps() {
  if (linking || moduleId === null) return;
  linking = true;
  try {
    const { stdout } = await run("pw-dump", [], { maxBuffer: 64 * 1024 * 1024 });
    const objects = JSON.parse(stdout);
    const nodes = objects.filter((o) => o.type === "PipeWire:Interface:Node");
    const ports = objects.filter((o) => o.type === "PipeWire:Interface:Port");
    const links = new Set(objects.filter((o) => o.type === "PipeWire:Interface:Link")
      .map((o) => `${o.info?.["output-port-id"]}:${o.info?.["input-port-id"]}`));
    const target = nodes.find((n) => n.info?.props?.["node.name"] === sinkName);
    if (!target) return;
    const inputs = ports.filter((p) => p.info?.direction === "input" && p.info?.props?.["node.id"] === target.id);
    const input = (channel) => inputs.find((p) => p.info.props["audio.channel"] === channel)?.id;
    const own = new Set(app.getAppMetrics().map((m) => m.pid));
    const apps = nodes.filter((n) => n.info?.props?.["media.class"] === "Stream/Output/Audio"
      && !own.has(Number(n.info.props["application.process.id"])));
    for (const node of apps) {
      for (const port of ports.filter((p) => p.info?.direction === "output" && p.info?.props?.["node.id"] === node.id)) {
        const channel = port.info.props["audio.channel"];
        const to = left.has(channel) ? [input("FL")] : right.has(channel) ? [input("FR")] : both.has(channel) ? [input("FL"), input("FR")] : [];
        for (const id of to) {
          if (id === undefined || links.has(`${port.id}:${id}`)) continue;
          await run("pw-link", [String(port.id), String(id)]).catch((e) => console.warn("pw-link failed:", e.message));
        }
      }
    }
  } catch (e) {
    console.warn("Linking screen share audio failed:", e.message);
  } finally {
    linking = false;
  }
}
