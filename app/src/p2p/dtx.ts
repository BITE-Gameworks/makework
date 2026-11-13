// Opus silence suppression (DTX) for calls in a mesh. Without it every copy of a mic went out at 50 packets a second
// even while nobody spoke (mesh-test s14: a muted call of 8 still sent 400 packets a second per member). An encoder
// uses DTX when the other side's description asks for it (`usedtx=1`, RFC 7587), so each member adds it to the
// descriptions it is given: offers and answers alike, and its own encoder then sends a packet every 400 ms in silence.
// Calls through a node ask mediasoup-client for the same (`opusDtx`, sfu.ts).

// `sdp` with `usedtx=1` on every Opus format that doesn't say yet whether to use DTX.
export function withOpusDtx(sdp: string): string {
  const opus = new Set([...sdp.matchAll(/^a=rtpmap:(\d+) opus\/48000/gim)].map((m) => m[1]));
  if (!opus.size) return sdp;
  return sdp.replace(/^a=fmtp:(\d+) ([^\r\n]*)/gm, (line, type: string, params: string) =>
    opus.has(type) && !/(^|;)\s*usedtx=/.test(params) ? `${line};usedtx=1` : line);
}

// A peer connection class (Trystero's `rtcPolyfill`) that asks for DTX in every description it is given.
export function opusDtxConnection(base: typeof RTCPeerConnection): typeof RTCPeerConnection {
  return class extends base {
    override setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
      return super.setRemoteDescription(description.sdp ? { ...description, sdp: withOpusDtx(description.sdp) } : description);
    }
  };
}
