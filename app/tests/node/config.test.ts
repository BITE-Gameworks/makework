// The node's settings from its command line (src/node/config.ts). `--rtc-ports` is the UDP range the firewall opens
// for the links between nodes serving a call: anything that isn't a whole range must be refused, not half saved, and a
// range saved before (by an older, looser check) is checked again when the node starts.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configFile, defaultRtcPort, mediaPort, parseRtcPort, parseRtcPorts, readConfig, savedRtcPorts } from "../../src/node/config";

describe("--rtc-ports", () => {
  it("takes a range of whole port numbers, one port or privileged ones included", () => {
    expect(parseRtcPorts("40000-40199")).toEqual({ min: 40000, max: 40199 });
    expect(parseRtcPorts(" 20000 - 49999 ")).toEqual({ min: 20000, max: 49999 });
    expect(parseRtcPorts("40000-40000")).toEqual({ min: 40000, max: 40000 });
    expect(parseRtcPorts("80-90")).toEqual({ min: 80, max: 90 });
  });

  it("refuses anything that isn't a whole range of ports", () => {
    for (const text of ["40000", "a-b", "40000.5-40100", "40100-40000", "0-100", "1000-70000", "-40000", "40000-", "40000-40100-40200"]) {
      expect(() => parseRtcPorts(text), text).toThrow("--rtc-ports wants a range like 20000-49999.");
    }
  });

  it("checks a range saved in node.json when the node starts", () => {
    expect(savedRtcPorts({})).toBeNull();
    expect(savedRtcPorts({ rtcMinPort: 40000, rtcMaxPort: 40199 })).toEqual({ min: 40000, max: 40199 });
    // Half a range, as the old check could save: mediasoup would use ports nobody opened.
    expect(() => savedRtcPorts({ rtcMinPort: 40000 })).toThrow("node.json");
  });
});

// `--rtc-port` is the one port members' call media comes in on (UDP and TCP), the one a home router forwards.
describe("--rtc-port", () => {
  it("takes one whole port number", () => {
    expect(parseRtcPort("40000")).toBe(40000);
    expect(parseRtcPort(" 3478 ")).toBe(3478);
    for (const text of ["", "0", "70000", "40000-40100", "4e4", "40000.5", "port"]) {
      expect(() => parseRtcPort(text), text).toThrow("--rtc-port wants a port like 40000.");
    }
  });

  it("defaults to the first port of the saved range (already opened for the old random ports), else 40000", () => {
    expect(mediaPort({}, null)).toBe(defaultRtcPort);
    expect(mediaPort({}, { min: 20000 })).toBe(20000);
    expect(mediaPort({ rtcPort: 44444 }, { min: 20000 })).toBe(44444);
    expect(() => mediaPort({ rtcPort: 0 }, null)).toThrow("node.json");
  });
});

// `--receivers`: how many members' new uploads a node takes at once.
describe("node.json from before a setting existed", () => {
  it("reads with that setting's default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mw-config-"));
    try {
      await writeFile(configFile(dir), JSON.stringify({ port: 9000, senders: 16, servers: [] }));
      const config = await readConfig(dir);
      expect(config.port).toBe(9000);
      expect(config.senders).toBe(16);
      expect(config.receivers).toBe(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
