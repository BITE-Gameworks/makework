// Keep playback, recovery and diagnostics looking at the same track. A stream can contain obsolete receivers after
// renegotiation; prefer its newest live, unmuted track, falling back to the newest live track during a handoff.
export function micTrack(stream: MediaStream): MediaStreamTrack | undefined {
  const live = stream.getAudioTracks().filter((track) => track.readyState !== "ended");
  return live.findLast((track) => !track.muted) ?? live.at(-1);
}

// A receiver's report, not the whole peer connection (which can carry several members' microphones).
export function readMicStats(report: RTCStatsReport): { bytes: number; packets: number; lost: number; level?: number } {
  let bytes = 0, packets = 0, lost = 0;
  let level: number | undefined;
  report.forEach((row) => {
    if (row.type !== "inbound-rtp" || (row.kind ?? row.mediaType) !== "audio") return;
    bytes += Number(row.bytesReceived ?? 0);
    packets += Number(row.packetsReceived ?? 0);
    lost += Number(row.packetsLost ?? 0);
    if (typeof row.audioLevel === "number") level = Math.max(level ?? 0, row.audioLevel);
  });
  return { bytes, packets, lost, level };
}
