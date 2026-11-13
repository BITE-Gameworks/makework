import { describe, expect, it } from "vitest";
import { opusDtxConnection, withOpusDtx } from "../../src/p2p/dtx";

// The audio part of an offer from Chromium for a call: the mic and a shared screen's sound, Opus on payload type 111.
const offer = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1 2",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "a=mid:0",
  "a=sctp-port:5000",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
  "a=mid:1",
  "a=rtpmap:111 opus/48000/2",
  "a=rtcp-fb:111 transport-cc",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "a=rtpmap:9 G722/8000",
  "a=rtpmap:126 telephone-event/8000",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
  "a=mid:2",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "",
].join("\r\n");

describe("Opus silence suppression (DTX)", () => {
  it("asks for DTX on every Opus stream, nothing else changes", () => {
    const lines = withOpusDtx(offer).split("\r\n");
    expect(lines.filter((l) => l.startsWith("a=fmtp:111"))).toEqual([
      "a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1",
      "a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1",
    ]);
    expect(lines.filter((l) => l.startsWith("a=fmtp:63"))).toEqual(["a=fmtp:63 111/111", "a=fmtp:63 111/111"]);
    expect(lines).toHaveLength(offer.split("\r\n").length);
  });

  it("keeps a description that already says whether to use DTX, or has no Opus", () => {
    const said = offer.replace("minptime=10;useinbandfec=1", "minptime=10;usedtx=0;useinbandfec=1");
    expect(withOpusDtx(said)).toContain("a=fmtp:111 minptime=10;usedtx=0;useinbandfec=1\r\n");
    expect(withOpusDtx(said)).not.toContain("usedtx=0;useinbandfec=1;usedtx=1");
    const dataOnly = offer.split("m=audio")[0];
    expect(withOpusDtx(dataOnly)).toBe(dataOnly);
  });

  it("follows the payload type the other side chose for Opus", () => {
    const firefox = "m=audio 9 UDP/TLS/RTP/SAVPF 109 9\r\na=rtpmap:109 opus/48000/2\r\na=fmtp:109 maxplaybackrate=48000;stereo=1;useinbandfec=1\r\na=rtpmap:9 G722/8000\r\na=fmtp:9 x=1\r\n";
    expect(withOpusDtx(firefox)).toBe("m=audio 9 UDP/TLS/RTP/SAVPF 109 9\r\na=rtpmap:109 opus/48000/2\r\na=fmtp:109 maxplaybackrate=48000;stereo=1;useinbandfec=1;usedtx=1\r\na=rtpmap:9 G722/8000\r\na=fmtp:9 x=1\r\n");
  });

  // The other member's description sets what this side's encoder does, so the connection asks for DTX in what it is
  // given: offers and answers, never rollbacks or candidates.
  it("a connection applies it to every description it is given", async () => {
    const given: (RTCSessionDescriptionInit | undefined)[] = [];
    class Base {
      async setRemoteDescription(description?: RTCSessionDescriptionInit): Promise<void> {
        given.push(description);
      }
    }
    const Connection = opusDtxConnection(Base as unknown as typeof RTCPeerConnection);
    const pc = new Connection();
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setRemoteDescription({ type: "rollback" });
    expect(given[0]).toEqual({ type: "offer", sdp: withOpusDtx(offer) });
    expect(given[0]?.sdp).toContain("usedtx=1");
    expect(given[1]).toEqual({ type: "rollback" });
  });
});
