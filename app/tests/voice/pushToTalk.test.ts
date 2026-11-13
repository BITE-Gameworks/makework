import { describe, expect, it } from "vitest";
import { defaultPttKey, matchesPttKey, micTransmits, pttKeyFromEvent, pttKeyLabel, type PttEvent } from "../../src/voice/pushToTalk";

const event = (code: string, modifiers: Partial<PttEvent> = {}): PttEvent => ({ code, ...modifiers });

describe("push to talk keys", () => {
  it("names the default key", () => {
    expect(pttKeyLabel(defaultPttKey)).toBe("F8");
  });

  it("shows modifiers and named keys", () => {
    expect(pttKeyLabel({ ...defaultPttKey, code: "KeyV", ctrl: true, shift: true })).toBe("Ctrl+Shift+V");
    expect(pttKeyLabel({ ...defaultPttKey, code: "Digit1" })).toBe("1");
    expect(pttKeyLabel({ ...defaultPttKey, code: "Space" })).toBe("Space");
    expect(pttKeyLabel({ ...defaultPttKey, code: "ArrowUp" })).toBe("Up");
    expect(pttKeyLabel({ ...defaultPttKey, code: "Backquote" })).toBe("`");
    expect(pttKeyLabel({ ...defaultPttKey, code: "NumpadAdd" })).toBe("Num +");
  });

  it("matches the exact code and modifiers", () => {
    const ctrlF8 = { ...defaultPttKey, ctrl: true };
    expect(matchesPttKey(event("F8", { ctrlKey: true }), ctrlF8)).toBe(true);
    expect(matchesPttKey(event("F8"), ctrlF8)).toBe(false);
    expect(matchesPttKey(event("F9", { ctrlKey: true }), ctrlF8)).toBe(false);
    expect(matchesPttKey(event("F8", { ctrlKey: true, shiftKey: true }), ctrlF8)).toBe(false);
  });

  it("takes a binding from a key press", () => {
    expect(pttKeyFromEvent(event("KeyV", { ctrlKey: true }))).toEqual({ code: "KeyV", ctrl: true, alt: false, shift: false, meta: false });
    expect(pttKeyFromEvent(event("ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(pttKeyFromEvent(event("ControlRight", { ctrlKey: true }))).toBeNull();
    expect(pttKeyFromEvent(event("CapsLock"))).toBeNull();
  });
});

describe("when the microphone sends", () => {
  const voice = { mode: "voice" as const, muted: false, deafened: false, talking: false };
  const ptt = { ...voice, mode: "push-to-talk" as const };

  it("sends in voice activation unless muted or deafened", () => {
    expect(micTransmits(voice)).toBe(true);
    expect(micTransmits({ ...voice, muted: true })).toBe(false);
    expect(micTransmits({ ...voice, deafened: true })).toBe(false);
  });

  it("sends in push to talk only while talking", () => {
    expect(micTransmits(ptt)).toBe(false);
    expect(micTransmits({ ...ptt, talking: true })).toBe(true);
    expect(micTransmits({ ...ptt, talking: true, muted: true })).toBe(false);
    expect(micTransmits({ ...ptt, talking: true, deafened: true })).toBe(false);
  });
});
