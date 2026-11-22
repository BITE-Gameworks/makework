import { describe, expect, it } from "vitest";
import { cameraChoices, deviceIdFor, isSystemCamera, systemCameraId, type SystemCamera } from "../../src/voice/cameras";

const device = (deviceId: string, label = "", kind: MediaDeviceKind = "videoinput") =>
  ({ deviceId, label, kind, groupId: "", toJSON: () => ({}) }) as MediaDeviceInfo;

const camera = (id: string, facing: SystemCamera["facing"], usable = true): SystemCamera => ({ id, facing, usable });

describe("system camera ids", () => {
  it("reads the id from Chromium's Android labels", () => {
    expect(systemCameraId("camera2 0, facing back")).toBe("0");
    expect(systemCameraId("camera2 21, facing front")).toBe("21");
  });

  it("ignores other labels", () => {
    expect(systemCameraId("Integrated Webcam (0bda:58f4)")).toBeNull();
    expect(systemCameraId("")).toBeNull();
  });
});

describe("camera choices", () => {
  it("lists the browser's cameras by device id without a system list", () => {
    const devices = [device("default", "Default"), device("a", "Webcam"), device(""), device("b"), device("m", "Mic", "audioinput")];
    expect(cameraChoices(devices, null)).toEqual([{ id: "a", label: "Webcam" }, { id: "b", label: "Camera 2" }]);
  });

  it("lists only the system cameras that give pictures, named by side", () => {
    const system = [camera("0", "back"), camera("1", "front"), camera("2", "back"), camera("3", "front", false), camera("5", "external")];
    expect(cameraChoices([], system)).toEqual([
      { id: "android:0", label: "Back camera", facing: "environment" },
      { id: "android:1", label: "Front camera", facing: "user" },
      { id: "android:2", label: "Back camera 2", facing: "environment" },
      { id: "android:5", label: "External camera" },
    ]);
  });

  it("leaves out system cameras the WebView doesn't list once it names its cameras", () => {
    const system = [camera("0", "back"), camera("1", "front"), camera("2", "back")];
    const devices = [device("x", "camera2 0, facing back"), device("y", "camera2 1, facing front")];
    expect(cameraChoices(devices, system).map((c) => c.id)).toEqual(["android:0", "android:1"]);
  });
});

describe("devices for a choice", () => {
  const devices = [device("x", "camera2 0, facing back"), device("y", "camera2 1, facing front")];

  it("finds a system camera by the id in the WebView's label", () => {
    expect(isSystemCamera("android:1")).toBe(true);
    expect(deviceIdFor("android:1", devices)).toBe("y");
  });

  it("has none for a system camera the WebView doesn't name yet", () => {
    expect(deviceIdFor("android:1", [device(""), device("")])).toBeNull();
  });

  it("opens other choices by their device id", () => {
    expect(deviceIdFor("webcam-id", devices)).toBe("webcam-id");
    expect(deviceIdFor("", devices)).toBeNull();
  });
});
