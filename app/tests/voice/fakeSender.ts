// Fake media for call tests: tracks, streams, and an RTCRtpSender as far as screen-share tuning uses it.
//
// The sender holds to what Chrome's does: setParameters takes the object
// the last getParameters returned (its transactionId), only within the same task and only once; it rejects a changed
// number of encodings; it is async. A sender not negotiated yet can have no encodings at all.
export type FakeTrack = { kind: "audio" | "video"; id: string };

let ids = 0;

export class FakeSender {
  private params: RTCRtpSendParameters;
  private lastId: string | null = null;
  // How many times settings were read and applied, and whether this sender refuses every change (a browser without
  // a field).
  gets = 0;
  sets = 0;
  refuse = false;

  constructor(readonly track: FakeTrack | null, encodings: RTCRtpEncodingParameters[] = [{ active: true }]) {
    this.params = { transactionId: "", encodings, codecs: [], headerExtensions: [], rtcp: {} };
  }

  getParameters(): RTCRtpSendParameters {
    this.gets++;
    const id = `t${++ids}`;
    this.lastId = id;
    setTimeout(() => this.lastId === id && (this.lastId = null));
    return structuredClone({ ...this.params, transactionId: id });
  }

  setParameters(params: RTCRtpSendParameters): Promise<void> {
    if (this.refuse) return Promise.reject(new DOMException("not supported", "OperationError"));
    if (params.transactionId !== this.lastId) return Promise.reject(new DOMException("stale parameters", "InvalidModificationError"));
    if (params.encodings.length !== this.params.encodings.length) {
      return Promise.reject(new DOMException("encodings changed", "InvalidModificationError"));
    }
    this.lastId = null;
    this.params = structuredClone(params);
    this.sets++;
    return Promise.resolve();
  }

  // The connection was negotiated: a sender made without encodings gets its one.
  negotiate(): void {
    if (this.params.encodings.length === 0) this.params.encodings = [{ active: true }];
  }

  // What the sender sends with now.
  get current(): RTCRtpSendParameters {
    return this.params;
  }

  // Its own getStats() report, as a test sets it.
  report = new Map<string, Record<string, unknown>>();
  getStats(): Promise<RTCStatsReport> {
    return Promise.resolve(this.report as unknown as RTCStatsReport);
  }
}

export function fakeTrack(kind: "audio" | "video"): FakeTrack {
  return { kind, id: `${kind}${++ids}` };
}

// A MediaStream as far as the call code reads one.
export type FakeStream = { id: string; getTracks(): FakeTrack[]; getVideoTracks(): FakeTrack[]; getAudioTracks(): FakeTrack[] };

export function fakeStream(...tracks: FakeTrack[]): FakeStream {
  return {
    id: `s${++ids}`,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  };
}

// `MediaStream` for code that makes a stream of some tracks (node has none): `vi.stubGlobal("MediaStream", FakeMediaStream)`.
export class FakeMediaStream implements FakeStream {
  readonly id = `s${++ids}`;
  constructor(private readonly tracks: FakeTrack[] = []) {}
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
}
