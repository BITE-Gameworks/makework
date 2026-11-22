// The cameras the call's camera menu offers. On Android they come from the system (CamerasPlugin.java): the WebView
// also lists depth and infrared sensors no app can stream from, and its device ids change with every launch, so a
// choice there is kept by the system's camera id. Elsewhere they are the browser's video inputs, kept by device id.
import { Capacitor, registerPlugin } from "@capacitor/core";

export type CameraFacing = "user" | "environment";

export interface CameraChoice {
  // What the choice is saved as: a device id, or the system's camera id after `systemPrefix`.
  id: string;
  label: string;
  facing?: CameraFacing;
}

export interface SystemCamera {
  id: string;
  facing: "front" | "back" | "external";
  usable: boolean;
}

interface NativeCameras {
  list(): Promise<{ cameras: SystemCamera[] }>;
}

const nativeCameras = Capacitor.getPlatform() === "android" ? registerPlugin<NativeCameras>("Cameras") : null;

const systemPrefix = "android:";

const sideNames: Record<SystemCamera["facing"], string> = { front: "Front camera", back: "Back camera", external: "External camera" };
const sideFacing: Record<SystemCamera["facing"], CameraFacing | undefined> = { front: "user", back: "environment", external: undefined };

// Calls on a phone start with the front camera; elsewhere the system's default camera.
export const defaultCamera: MediaTrackConstraints | true = nativeCameras ? { facingMode: "user" } : true;

// Asked each time: an external camera can be plugged in. Null where the system can't be asked, also on an app
// build from before the plugin.
export async function systemCameras(): Promise<SystemCamera[] | null> {
  if (!nativeCameras) return null;
  try {
    return (await nativeCameras.list()).cameras;
  } catch (e) {
    console.warn("The system's cameras couldn't be listed; using the WebView's list:", e);
    return null;
  }
}

export function isSystemCamera(id: string): boolean {
  return id.startsWith(systemPrefix);
}

// Chromium names Android cameras "camera2 <system id>, facing <side>".
export function systemCameraId(label: string): string | null {
  return /^camera2 ([^,\s]+),/.exec(label)?.[1] ?? null;
}

export function cameraChoices(devices: MediaDeviceInfo[], system: SystemCamera[] | null): CameraChoice[] {
  const videoInputs = devices.filter((d) => d.kind === "videoinput" && d.deviceId && d.deviceId !== "default");
  if (!system) return videoInputs.map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  // Once the WebView names its cameras (after one has been open), a system camera it doesn't list can't be opened.
  const listed = new Set(videoInputs.map((d) => systemCameraId(d.label)).filter((id) => id !== null));
  const perSide: Record<SystemCamera["facing"], number> = { front: 0, back: 0, external: 0 };
  return system.filter((c) => c.usable && (listed.size === 0 || listed.has(c.id))).map((c) => {
    const count = ++perSide[c.facing];
    const facing = sideFacing[c.facing];
    return { id: systemPrefix + c.id, label: count > 1 ? `${sideNames[c.facing]} ${count}` : sideNames[c.facing], ...(facing && { facing }) };
  });
}

// The device id to open a choice with. A system camera has one only once the WebView names its cameras; any other
// choice is its device id, which may be gone (unplugged).
export function deviceIdFor(id: string, devices: MediaDeviceInfo[]): string | null {
  if (!isSystemCamera(id)) return id || null;
  const systemId = id.slice(systemPrefix.length);
  return devices.find((d) => d.kind === "videoinput" && d.deviceId && systemCameraId(d.label) === systemId)?.deviceId ?? null;
}
