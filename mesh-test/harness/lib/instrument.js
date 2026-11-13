// Injected into every client page (CDP init script before the app loads, or evaluated late after a restart).
// Observes without changing behaviour: RTCPeerConnections, Nostr WebSockets, data channel frames by Trystero
// action, console output, and (once the app's modules are loaded) WorkspaceSync instances per workspace and every
// Ledger.accept/replay. Everything lands on window.__mwt for the harness to read.
(() => {
  if (window.top !== window || window.__mwt) return;
  const W = (window.__mwt = {
    v: 1,
    installedAt: Date.now(),
    early: document.readyState === "loading",
    logs: [],
    logBase: 0,
    pcs: [],
    ws: {},
    dc: { sent: {}, recv: {}, sentBytes: 0, recvBytes: 0, sentFrames: 0, recvFrames: 0, recvTimeline: [] },
    syncs: new Map(),
    acc: {},
    seen: {},
    rowIds: {},
    content: [],
    patched: false,
    patchInfo: null,
  });

  const maxLogs = 20000;
  const clip = (s, n = 1500) => (s.length > n ? `${s.slice(0, n)}…(${s.length})` : s);
  const show = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    try {
      return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x)) ?? String(v);
    } catch {
      return String(v);
    }
  };
  const warnKinds = [
    ["could-not-connect", /^Could not connect to member/], ["attach-failed", /^Stream attachment failed/],
    ["call-line", /^Call: /], ["turn-not-loaded", /^TURN credentials not/], ["announce-failed", /announce failed/],
  ];
  const pushLog = (level, args) => {
    const text = args.map(show).join(" ");
    if (level === "warn" || level === "error" || level === "info") for (const [name, re] of warnKinds) if (re.test(text)) W.noteEvent?.(`log:${name}`);
    W.logs.push({ t: Date.now(), l: level, m: clip(text) });
    if (W.logs.length > maxLogs) {
      const drop = W.logs.length - maxLogs;
      W.logs.splice(0, drop);
      W.logBase += drop;
    }
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        pushLog(level, args);
      } catch {}
      original(...args);
    };
  }
  addEventListener("error", (e) => pushLog("pageerror", [e.message ?? String(e)]));
  addEventListener("unhandledrejection", (e) => pushLog("rejection", [e.reason ?? "unhandled rejection"]));
  // Entries from absolute index `cursor` on (at most `max`), and the next cursor.
  W.logsSince = (cursor = 0, max = 3000) => {
    const start = Math.max(0, cursor - W.logBase);
    const entries = W.logs.slice(start, start + max);
    return { entries, next: W.logBase + start + entries.length, dropped: Math.max(0, W.logBase - cursor) };
  };

  // ---- census (s17 online drift): what can pile up while a peer stays connected ----
  // Live intervals by the app line that made them, pending timeouts, animation frames asked for, and event listeners
  // added and not removed by (target, event). Read with W.census().
  // `events`: cumulative counts of app and connection events (connections made and closed, ICE candidates by type,
  // mesh moves and failures, warnings), read as rates by the harness.
  const census = (W.censusState = { intervals: new Map(), timeouts: new Set(), timeoutsMade: 0, frames: 0, listeners: new Map(), channels: [], events: {} });
  const note = (W.noteEvent = (name) => {
    census.events[name] = (census.events[name] ?? 0) + 1;
  });
  const siteOf = () => {
    const lines = String(new Error().stack ?? "").split("\n").slice(2);
    const line = lines.find((l) => l.includes("/src/") || l.includes("/node_modules/") || l.includes("/vendor/")) ?? lines[0] ?? "?";
    return line.trim().replace(/^at /, "").replace(/\?[^:)]*/, "").replace(/https?:\/\/[^/]+/, "");
  };
  {
    const setI = window.setInterval;
    const clearI = window.clearInterval;
    const setT = window.setTimeout;
    const clearT = window.clearTimeout;
    const raf = window.requestAnimationFrame;
    window.setInterval = function (fn, ms, ...rest) {
      const id = setI.call(window, fn, ms, ...rest);
      try {
        census.intervals.set(id, `${siteOf()} every ${ms}`);
      } catch {}
      return id;
    };
    window.clearInterval = function (id) {
      census.intervals.delete(id);
      return clearI.call(window, id);
    };
    window.setTimeout = function (fn, ms, ...rest) {
      let id;
      const run = typeof fn === "function" ? function (...a) {
        census.timeouts.delete(id);
        return fn.apply(this, a);
      } : fn;
      id = setT.call(window, run, ms, ...rest);
      census.timeouts.add(id);
      census.timeoutsMade++;
      return id;
    };
    window.clearTimeout = function (id) {
      census.timeouts.delete(id);
      return clearT.call(window, id);
    };
    window.requestAnimationFrame = function (fn) {
      census.frames++;
      return raf.call(window, fn);
    };
    const registered = new WeakMap();
    const keyOf = (target, type) => `${target?.constructor?.name ?? "?"}:${type}`;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      try {
        if (listener) {
          const capture = typeof options === "boolean" ? options : !!options?.capture;
          const map = registered.get(this) ?? registered.set(this, new Map()).get(this);
          const k = `${type}|${capture}`;
          const set = map.get(k) ?? map.set(k, new Set()).get(k);
          if (!set.has(listener)) {
            set.add(listener);
            const key = keyOf(this, type);
            census.listeners.set(key, (census.listeners.get(key) ?? 0) + 1);
          }
        }
      } catch {}
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      try {
        const capture = typeof options === "boolean" ? options : !!options?.capture;
        const set = registered.get(this)?.get(`${type}|${capture}`);
        if (set?.delete(listener)) {
          const key = keyOf(this, type);
          census.listeners.set(key, (census.listeners.get(key) ?? 1) - 1);
        }
      } catch {}
      return remove.call(this, type, listener, options);
    };
  }

  // ---- data channel frames (Trystero 0.26 wire: room frame [1, len16, token] + action [2, kind, type32, ...]) ----
  const decoder = new TextDecoder();
  const bytesOf = (data) => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  };
  const frameType = (b) => {
    if (!b || b.length < 3) return "#other";
    if (b[0] === 2) return "#room-presence";
    if (b[0] !== 1) return "#other";
    const tokenLength = (b[1] << 8) | b[2];
    const at = 3 + tokenLength;
    if (b.length < at + 2 || b[at] !== 2) return "#other";
    const kind = b[at + 1];
    if (kind === 0 || kind === 1) {
      if (b.length < at + 34) return "#short";
      const name = decoder.decode(b.subarray(at + 2, at + 34)).replaceAll("\0", "");
      return kind === 1 ? `${name}(offer)` : name;
    }
    return kind === 2 ? "#chunk" : "#control";
  };
  const count = (bucket, data, isSend) => {
    const b = bytesOf(data);
    const size = b ? b.length : typeof data === "string" ? data.length : (data?.size ?? 0);
    const type = b ? frameType(b) : typeof data === "string" ? "#string" : "#blob";
    const entry = (bucket[type] ??= { n: 0, bytes: 0, first: Date.now(), last: 0 });
    entry.n++;
    entry.bytes += size;
    entry.last = Date.now();
    if (isSend) {
      W.dc.sentFrames++;
      W.dc.sentBytes += size;
    } else {
      W.dc.recvFrames++;
      W.dc.recvBytes += size;
      // Each received frame's time, type and size (the first 6000): how fast data comes in, e.g. a joiner's history.
      if (W.dc.recvTimeline.length < 6000) W.dc.recvTimeline.push([Date.now(), type, size]);
    }
  };
  if (window.RTCDataChannel) {
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) {
      try {
        count(W.dc.sent, data, true);
      } catch {}
      return send.call(this, data);
    };
  }
  const watched = new WeakSet();
  const watchChannel = (channel) => {
    if (!channel || watched.has(channel)) return;
    watched.add(channel);
    census.channels.push(channel);
    channel.addEventListener("message", (e) => {
      try {
        count(W.dc.recv, e.data, false);
      } catch {}
    });
  };

  // ---- RTCPeerConnection ----
  const OriginalPC = window.RTCPeerConnection;
  if (OriginalPC) {
    let nextId = 1;
    const track = (pc, config) => {
      const urls = (config?.iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).map(String);
      const rec = {
        id: nextId++,
        created: Date.now(),
        turnUrls: urls.filter((u) => u.startsWith("turn")).length,
        stunUrls: urls.filter((u) => u.startsWith("stun")).length,
        state: pc.connectionState,
        iceState: pc.iceConnectionState,
        states: [[Date.now(), pc.connectionState]],
        iceStates: [[Date.now(), pc.iceConnectionState]],
        connectedAt: null,
        failedAt: null,
        closedAt: null,
        sel: null,
        selAt: 0,
        bytesSent: 0,
        bytesReceived: 0,
      };
      Object.defineProperty(rec, "pc", { value: pc, enumerable: false, writable: true });
      W.pcs.push(rec);
      W.noteEvent("pc:made");
      if (W.pcs.length > 3000) {
        const i = W.pcs.findIndex((r) => r.closedAt);
        W.pcs.splice(Math.max(i, 0), 1);
      }
      pc.addEventListener("connectionstatechange", () => {
        const s = pc.connectionState;
        rec.state = s;
        rec.states.push([Date.now(), s]);
        W.noteEvent(`pc:${s}`);
        if (s === "connected" && !rec.connectedAt) rec.connectedAt = Date.now();
        if (s === "failed" && !rec.failedAt) rec.failedAt = Date.now();
        if (s === "closed" && !rec.closedAt) rec.closedAt = Date.now();
      });
      pc.addEventListener("iceconnectionstatechange", () => {
        rec.iceState = pc.iceConnectionState;
        rec.iceStates.push([Date.now(), pc.iceConnectionState]);
      });
      pc.addEventListener("datachannel", (e) => watchChannel(e.channel));
      pc.addEventListener("icecandidate", (e) => {
        const c = e.candidate;
        if (!c) return W.noteEvent("ice:done");
        W.noteEvent(`ice:${c.type ?? / typ (\w+)/.exec(c.candidate ?? "")?.[1] ?? "?"}`);
      });
      return rec;
    };
    class InstrumentedPC extends OriginalPC {
      constructor(config, ...rest) {
        super(config, ...rest);
        try {
          this.__mwtRec = track(this, config);
        } catch {}
      }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        try {
          watchChannel(channel);
        } catch {}
        return channel;
      }
      close() {
        const rec = this.__mwtRec;
        if (rec && !rec.closedAt) {
          W.noteEvent(rec.connectedAt ? "pc:closed-local" : "pc:closed-local-never-connected");
          rec.closedAt = Date.now();
          rec.state = "closed";
          rec.states.push([Date.now(), "closed(local)"]);
        }
        return super.close();
      }
    }
    window.RTCPeerConnection = InstrumentedPC;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = InstrumentedPC;

    // Which candidate pair each connected PC uses (host/srflx/relay) and its traffic.
    const sample = async (rec) => {
      const pc = rec.pc;
      if (!pc) return;
      const report = await pc.getStats();
      let pairId = null;
      report.forEach((s) => {
        if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      });
      let pair = pairId ? report.get(pairId) : null;
      if (!pair) report.forEach((s) => {
        if (!pair && s.type === "candidate-pair" && s.state === "succeeded" && (s.nominated || s.selected)) pair = s;
      });
      if (!pair) return;
      const local = report.get(pair.localCandidateId);
      const remote = report.get(pair.remoteCandidateId);
      rec.sel = {
        local: local?.candidateType ?? null,
        localAddress: local?.address ?? local?.ip ?? null,
        remote: remote?.candidateType ?? null,
        remoteAddress: remote?.address ?? remote?.ip ?? null,
        protocol: local?.protocol ?? null,
        relayProtocol: local?.relayProtocol ?? null,
        rtt: pair.currentRoundTripTime ?? null,
      };
      rec.selAt = Date.now();
      rec.bytesSent = pair.bytesSent ?? 0;
      rec.bytesReceived = pair.bytesReceived ?? 0;
    };
    setInterval(() => {
      const t = Date.now();
      for (const rec of W.pcs) {
        if (rec.closedAt) {
          rec.pc = null;
          continue;
        }
        if (rec.state === "connected" && (!rec.sel || t - rec.selAt > 15000)) void sample(rec).catch(() => {});
      }
    }, 4000);
  }

  W.pcSummary = () => {
    const byState = {};
    const pairs = {};
    let failedEver = 0;
    let withTurn = 0;
    for (const r of W.pcs) {
      byState[r.state] = (byState[r.state] ?? 0) + 1;
      if (r.failedAt) failedEver++;
      if (r.turnUrls > 0) withTurn++;
      if (r.state === "connected" && r.sel) {
        const key = `${r.sel.local}-${r.sel.remote}`;
        pairs[key] = (pairs[key] ?? 0) + 1;
      }
    }
    return { total: W.pcs.length, connected: byState.connected ?? 0, byState, failedEver, withTurn, pairs };
  };
  W.pcDetail = () => W.pcs.map((r) => ({ ...r, states: r.states.slice(-20), iceStates: r.iceStates.slice(-20) }));

  // ---- WebSocket (Nostr relays; the Vite HMR socket shows up too) ----
  const OriginalWS = window.WebSocket;
  if (OriginalWS) {
    const recFor = (url) =>
      (W.ws[url] ??= {
        url, created: 0, opens: 0, closes: 0, errors: 0, framesOut: 0, framesIn: 0, eventsOut: 0, eventsIn: 0,
        reqs: 0, okFalse: 0, eose: 0, rateLimited: 0, notices: [], firstOpenAt: null, lastOpenAt: null, lastCloseAt: null,
        closeCodes: {},
      });
    const keep = (rec, text) => {
      if (rec.notices.length < 200) rec.notices.push({ t: Date.now(), m: clip(text, 400) });
      if (/rate|limit|too many|slow down|throttl/i.test(text)) rec.rateLimited++;
    };
    class InstrumentedWS extends OriginalWS {
      constructor(url, protocols) {
        super(url, protocols);
        try {
          const rec = recFor(String(url));
          rec.created++;
          Object.defineProperty(this, "__mwtRec", { value: rec, enumerable: false });
          this.addEventListener("open", () => {
            rec.opens++;
            rec.lastOpenAt = Date.now();
            rec.firstOpenAt ??= rec.lastOpenAt;
          });
          this.addEventListener("close", (e) => {
            rec.closes++;
            rec.lastCloseAt = Date.now();
            rec.closeCodes[e.code] = (rec.closeCodes[e.code] ?? 0) + 1;
          });
          this.addEventListener("error", () => rec.errors++);
          this.addEventListener("message", (e) => {
            rec.framesIn++;
            const d = typeof e.data === "string" ? e.data : "";
            if (d.startsWith('["EVENT"')) rec.eventsIn++;
            else if (d.startsWith('["EOSE"')) rec.eose++;
            else if (d.startsWith('["NOTICE"') || d.startsWith('["CLOSED"')) keep(rec, d);
            else if (d.startsWith('["OK"')) {
              try {
                const msg = JSON.parse(d);
                if (msg[2] === false) {
                  rec.okFalse++;
                  keep(rec, d);
                }
              } catch {}
            }
          });
        } catch {}
      }
      send(data) {
        try {
          const rec = this.__mwtRec;
          if (rec) {
            rec.framesOut++;
            if (typeof data === "string") {
              if (data.startsWith('["EVENT"')) rec.eventsOut++;
              else if (data.startsWith('["REQ"')) rec.reqs++;
            }
          }
        } catch {}
        return super.send(data);
      }
    }
    window.WebSocket = InstrumentedWS;
  }
  W.wsSummary = () => {
    const out = {};
    for (const [url, r] of Object.entries(W.ws)) {
      const { notices, ...rest } = r;
      out[url] = { ...rest, notices: notices.length };
    }
    return out;
  };

  // ---- app modules (Vite dev serves them by path; the same URL gives the app's own module instance) ----
  const accFor = (sid) =>
    (W.acc[sid] ??= {
      calls: 0, received: 0, fresh: 0, dupFresh: 0, ms: 0, replays: 0, replayMs: 0, hashes: new Set(),
    });
  const seenFor = (sid) => (W.seen[sid] ??= {});
  const tagPattern = /mwt\|[A-Za-z0-9_.:-]+(?:\|[A-Za-z0-9_.:-]+)*/;
  W.patch = async () => {
    if (W.patched) return W.patchInfo;
    const info = { at: Date.now() };
    try {
      const { WorkspaceSync } = await import("/src/p2p/sync.ts");
      const proto = WorkspaceSync.prototype;
      const register = (sync) => {
        try {
          const sid = sync?.ledger?.workspaceId;
          if (sid && !sync.__mwtClosed) W.syncs.set(sid, sync);
        } catch {}
      };
      for (const name of ["onPeers", "hello", "receive", "countPeers", "broadcast"]) {
        const original = proto[name];
        if (typeof original !== "function" || original.__mwt) continue;
        const wrapped = function (...args) {
          register(this);
          return original.apply(this, args);
        };
        wrapped.__mwt = true;
        proto[name] = wrapped;
      }
      const close = proto.close;
      if (!close.__mwt) {
        proto.close = function (...args) {
          this.__mwtClosed = true;
          const sid = this.ledger?.workspaceId;
          if (sid && W.syncs.get(sid) === this) W.syncs.delete(sid);
          return close.apply(this, args);
        };
        proto.close.__mwt = true;
      }
      info.sync = true;
    } catch (e) {
      info.syncError = String(e?.message ?? e);
    }
    try {
      const { Ledger } = await import("/src/p2p/ledger.ts");
      const proto = Ledger.prototype;
      // Experiment "dedupe" (MWT_EXPERIMENTS): drops commits already seen or still being accepted (same sig) before
      // they are verified, to test whether the duplicate-accept race drives the commit flood. Inside the counters
      // below, so they show what is left.
      if ((window.__mwtExperiments ?? []).includes("dedupe") && !proto.accept.__mwtDedupe) {
        const inner = proto.accept;
        proto.accept = async function (raw, ...rest) {
          const known = (this.__mwtSigs ??= new Set());
          const keep = [];
          for (const r of Array.isArray(raw) ? raw : []) {
            const sig = r && typeof r.sig === "string" ? r.sig : null;
            if (sig && known.has(sig)) continue;
            if (sig) known.add(sig);
            keep.push(r);
          }
          return keep.length ? inner.call(this, keep, ...rest) : [];
        };
        proto.accept.__mwtDedupe = true;
        info.experiments = ["dedupe"];
      }
      const accept = proto.accept;
      if (!accept.__mwt) {
        // Every argument goes on: the second is the snapshot loader WorkspaceSync passes (without it a joiner refused
        // every snapshot it was sent).
        proto.accept = async function (raw, ...rest) {
          const a = accFor(this.workspaceId);
          a.calls++;
          a.received += Array.isArray(raw) ? raw.length : 0;
          const t0 = performance.now();
          const fresh = await accept.call(this, raw, ...rest);
          a.ms += performance.now() - t0;
          a.fresh += fresh.length;
          const t = Date.now();
          const seen = seenFor(this.workspaceId);
          for (const c of fresh) {
            if (a.hashes.has(c.hash)) a.dupFresh++;
            else a.hashes.add(c.hash);
            for (const op of c.ops ?? []) {
              if (op.table !== "chat_messages" || op.kind !== "insert") continue;
              const body = op.values?.body;
              const m = typeof body === "string" ? tagPattern.exec(body) : null;
              if (m && !(m[0] in seen)) seen[m[0]] = t;
              // The row id each tagged message was inserted under: two messages under one id (newRowId, ms * 2048 +
              // random) make the ledger refuse the second, which counts as seen here but is never in the table.
              if (m) (W.rowIds[this.workspaceId] ??= {})[m[0]] = op.id;
            }
          }
          return fresh;
        };
        proto.accept.__mwt = true;
      }
      const replay = proto.replay;
      if (typeof replay === "function" && !replay.__mwt) {
        proto.replay = function (...args) {
          const t0 = performance.now();
          try {
            return replay.apply(this, args);
          } finally {
            const a = accFor(this.workspaceId);
            a.replays++;
            a.replayMs += performance.now() - t0;
          }
        };
        proto.replay.__mwt = true;
      }
      info.ledger = true;
    } catch (e) {
      info.ledgerError = String(e?.message ?? e);
    }
    // Content asked for (ContentLink.ensureContent: the peers that could be asked then) and each transfer attempt
    // (ContentStreams.download: from whom, how it ended), the last 200 of each in W.content.
    try {
      const { ContentStreams } = await import("/src/p2p/stream.ts");
      const { ContentLink } = await import("/src/p2p/content.ts");
      const keep = (entry) => {
        W.content.push(entry);
        if (W.content.length > 200) W.content.shift();
      };
      const download = ContentStreams.prototype.download;
      if (!download.__mwt) {
        ContentStreams.prototype.download = async function (hash, peer, ...rest) {
          const t = Date.now();
          const result = await download.call(this, hash, peer, ...rest);
          keep({ t, ms: Date.now() - t, what: "download", hash: hash.slice(0, 8), peer, result });
          return result;
        };
        ContentStreams.prototype.download.__mwt = true;
      }
      const ensure = ContentLink.prototype.ensureContent;
      if (!ensure.__mwt) {
        ContentLink.prototype.ensureContent = function (hash, ...rest) {
          keep({ t: Date.now(), what: "ensure", hash: hash.slice(0, 8), peers: Object.keys(this.room?.getPeers() ?? {}).length });
          return ensure.call(this, hash, ...rest);
        };
        ContentLink.prototype.ensureContent.__mwt = true;
      }
      info.content = true;
    } catch (e) {
      info.contentError = String(e?.message ?? e);
    }
    // Call presence (s13): every presence sent, relayed, delivered or dropped, written and taken out again, in
    // W.voiceTrace (the last `maxTrace`). Instance closures (VoiceLink.sendPresence) are wrapped by W.traceVoice().
    try {
      const { VoiceLink } = await import("/src/p2p/voice.ts");
      const { Mesh } = await import("/src/p2p/mesh.ts");
      const { RoomGroup } = await import("/src/p2p/roomGroup.ts");
      const { WorkspaceSync } = await import("/src/p2p/sync.ts");
      W.voiceTrace = [];
      const maxTrace = 20000;
      const trace = (entry) => {
        W.voiceTrace.push({ t: Date.now(), ...entry });
        if (W.voiceTrace.length > maxTrace) W.voiceTrace.splice(0, W.voiceTrace.length - maxTrace);
      };
      W.trace = trace;
      const wrap = (proto, name, fn) => {
        const original = proto[name];
        if (typeof original !== "function" || original.__mwtVoice) return;
        proto[name] = function (...args) {
          return fn.call(this, original, args);
        };
        proto[name].__mwtVoice = true;
      };
      const tableOf = (link, user) => {
        try {
          return link.backend.data("voice").select("voice_participants", { user_id: user }).map((r) => Number(r.channel_id));
        } catch {
          return null;
        }
      };
      wrap(VoiceLink.prototype, "receive", function (original, [peer, presence]) {
        const before = JSON.stringify(this.peerRows.get(peer) ?? "none");
        const result = original.call(this, peer, presence);
        const user = presence?.userId;
        trace({
          e: this.__mwtExpiring ? "expire" : "recv", peer, user, ch: presence?.row ? Number(presence.row.channel_id) : null,
          node: presence?.node ?? null, changed: before !== JSON.stringify(this.peerRows.get(peer) ?? "none"),
          table: user === undefined ? null : tableOf(this, user), mine: this.channelId,
        });
        return result;
      });
      wrap(VoiceLink.prototype, "expireSilent", function (original, args) {
        this.__mwtExpiring = true;
        try {
          return original.apply(this, args);
        } finally {
          this.__mwtExpiring = false;
        }
      });
      wrap(VoiceLink.prototype, "forget", function (original, [peer]) {
        const user = this.peerUsers.get(peer);
        const result = original.call(this, peer);
        trace({ e: "forget", peer, user, table: user === undefined ? null : tableOf(this, user) });
        return result;
      });
      wrap(VoiceLink.prototype, "setLocal", function (original, [channel, ...rest]) {
        trace({ e: "setLocal", ch: channel });
        return original.call(this, channel, ...rest);
      });
      // Not vouched for on arrival: dropped before 2026-10-17, held since (Mesh.heldRelayed) until the go-between names
      // the sender, then let through ("relay-release") or dropped after a few seconds.
      const holds = typeof Mesh.prototype.releaseRelayed === "function";
      wrap(Mesh.prototype, "deliver", function (original, [relay, message]) {
        if (message?.ch === "voice") {
          // Route lists since 2026-10-20 (`vouches`), far lists before.
          const ok = typeof this.vouches === "function" ? this.vouches(relay, message.from)
            : !!(this.neighbors.get(relay)?.has(message.from) || this.far?.get(relay)?.has(message.from));
          trace({ e: ok ? "relay-in" : holds ? "relay-in-held" : "relay-in-dropped", relay, from: message.from, user: message.data?.userId, relayKnows: this.neighbors.get(relay)?.size ?? null });
        }
        return original.call(this, relay, message);
      });
      if (holds) wrap(Mesh.prototype, "releaseRelayed", function (original, [relay]) {
        const before = this.heldRelayed.get(relay)?.length ?? 0;
        const result = original.call(this, relay);
        const after = this.heldRelayed.get(relay)?.length ?? 0;
        if (before > 0) trace({ e: "relay-release", relay, before, after });
        return result;
      });
      wrap(Mesh.prototype, "passOn", function (original, [from, message]) {
        if (message?.ch === "voice")
          trace({ e: this.direct.has(message.to) ? "pass-on" : "pass-on-dropped", from, to: message.to, user: message.data?.userId });
        return original.call(this, from, message);
      });
      wrap(Mesh.prototype, "peerJoined", function (original, [peer]) {
        trace({ e: "direct+", peer, wasVia: this.via.get(peer) ?? null });
        return original.call(this, peer);
      });
      wrap(Mesh.prototype, "peerLeft", function (original, [peer]) {
        trace({ e: "direct-", peer });
        return original.call(this, peer);
      });
      wrap(Mesh.prototype, "peerMoved", function (original, [peer]) {
        trace({ e: "moved", peer });
        return original.call(this, peer);
      });
      wrap(Mesh.prototype, "update", function (original, args) {
        const before = new Set(this.reachable);
        // A route is a list of go-betweens since 2026-10-20, one go-between before.
        const routes = new Map([...this.via].map(([peer, route]) => [peer, String(route)]));
        const result = original.apply(this, args);
        for (const peer of this.reachable) if (!before.has(peer)) trace({ e: "reach+", peer, via: this.via.get(peer) ?? null });
        for (const peer of before) if (!this.reachable.has(peer)) trace({ e: "reach-", peer });
        for (const [peer, route] of this.via) if (routes.has(peer) && routes.get(peer) !== String(route)) trace({ e: "via", peer, route, was: routes.get(peer) });
        return result;
      });
      wrap(RoomGroup.prototype, "authorizePeer", function (original, [peer, access]) {
        trace({ e: "auth", peer, access, early: this.early.get(peer)?.length ?? 0, earlyStreams: this.earlyStreams?.get(peer)?.size ?? 0, rooms: this.peerRooms.get(peer) ?? [] });
        return original.call(this, peer, access);
      });
      wrap(RoomGroup.prototype, "add", function (original, [key, room]) {
        if (!this.rooms.has(key)) trace({ e: "room+", key });
        return original.call(this, key, room);
      });
      wrap(RoomGroup.prototype, "remove", function (original, [key]) {
        if (this.rooms.has(key)) trace({ e: "room-", key });
        return original.call(this, key);
      });
      // Experiment "nocallroom" (MWT_EXPERIMENTS): no call room, so call members never connect directly and presence
      // goes only through the nodes, as where members' direct connections fail (most home networks).
      const noCallRoom = (window.__mwtExperiments ?? []).includes("nocallroom");
      if (noCallRoom) info.experiments = [...(info.experiments ?? []), "nocallroom"];
      wrap(WorkspaceSync.prototype, "joinCall", function (original, [channel]) {
        trace({ e: "joinCall", ch: channel, was: this.call, secret: String(this.currentSecret ?? "").slice(0, 6), skipped: noCallRoom });
        if (noCallRoom) return;
        return original.call(this, channel);
      });
      wrap(WorkspaceSync.prototype, "rotateSecret", function (original, [secret]) {
        trace({ e: "rotate", from: String(this.currentSecret ?? "").slice(0, 6), to: String(secret ?? "").slice(0, 6), call: this.call });
        return original.call(this, secret);
      });
      // Peer authentication (node test): each challenge sent, each auth message received (its kind, whether it answered
      // our nonce, and whether the peer is known after it), and each room's peers coming and going, by room key.
      wrap(WorkspaceSync.prototype, "challengePeer", function (original, [peer]) {
        trace({ e: "auth-challenge", peer });
        return original.call(this, peer);
      });
      // The cut phase (s16): `W.slowProofMs` on a page checks each proof it gets that much later, like a device busy
      // reconnecting to everyone at once. The others then send it their streams before it has checked their proofs.
      // A room secret handed over proves the sender too (a member that joined with a still-open invite gets one on every
      // connection), so it waits as well.
      wrap(WorkspaceSync.prototype, "receivePeerAuth", async function (original, [message, peer, options]) {
        if ((message?.kind === "proof" || message?.kind === "secret") && W.slowProofMs > 0) await new Promise((resolve) => setTimeout(resolve, W.slowProofMs));
        const ours = message?.kind === "proof" ? this.authNonces.get(peer) === message?.nonce
          : message?.kind === "secret" ? this.peerNonces.get(peer) === message?.nonce : null;
        const result = await original.call(this, message, peer, options);
        trace({ e: "auth-in", peer, kind: message?.kind ?? null, ours, author: typeof message?.author === "string" ? message.author.slice(0, 8) : null, known: this.peerAuthors.has(peer) });
        return result;
      });
      wrap(RoomGroup.prototype, "listen", function (original, [key, room]) {
        const result = original.call(this, key, room);
        const join = room.onPeerJoin;
        const leave = room.onPeerLeave;
        room.onPeerJoin = (peer) => {
          trace({ e: "room-peer+", key, peer, before: [...(this.peerRooms.get(peer) ?? [])] });
          return join?.(peer);
        };
        room.onPeerLeave = (peer) => {
          trace({ e: "room-peer-", key, peer, before: [...(this.peerRooms.get(peer) ?? [])] });
          return leave?.(peer);
        };
        // A stream from a peer whose proof isn't checked here yet: dropped before 2026-10-21, held since.
        const stream = room.onPeerStream;
        room.onPeerStream = (s, peer, meta) => {
          if (!this.allowed(peer, "member")) trace({ e: "stream-early", key, peer, kind: meta?.kind ?? null, stream: s?.id?.slice(0, 8) ?? null });
          return stream?.(s, peer, meta);
        };
        return result;
      });
      // Node hellos (node test): which node, how far its clock is, and what came of it (online, waiting for the node's
      // row, or refused: stale, unknown or a bad signature).
      try {
        const { NodeLink } = await import("/src/p2p/nodes.ts");
        wrap(NodeLink.prototype, "receiveHello", async function (original, [hello, peer]) {
          const before = this.peers.has(peer);
          const result = await original.call(this, hello, peer);
          trace({
            e: "node-hello", peer, user: Number(hello?.user), skewMs: typeof hello?.time === "number" ? Date.now() - hello.time : null,
            outcome: this.peers.has(peer) ? (before ? "again" : "online") : this.waiting.has(peer) ? "waiting-for-row" : "refused",
          });
          return result;
        });
      } catch (e) {
        info.nodeHelloError = String(e?.message ?? e);
      }
      // Call hold (s16): what happens around a call going silent. Sync hellos and commit batches in and out, the rooms
      // sync wants, route lists, streams put on and taken off connections, nodes forgotten and back, the call's mode,
      // what VoiceLink sends each peer and which mic it shows. Instance closures (WorkspaceSync.sendRoom) are wrapped
      // by W.traceCall(). Experiments (MWT_EXPERIMENTS): "norecheck" drops the sync timer's hellos (`reply: true`)
      // while in a call; "noroutes" makes this member ignore route lists.
      try {
        const media = await import("/src/voice/media.ts");
        const { NodeLink } = await import("/src/p2p/nodes.ts");
        const experiments = window.__mwtExperiments ?? [];
        const noRecheck = experiments.includes("norecheck");
        const noRoutes = experiments.includes("noroutes");
        for (const name of ["norecheck", "noroutes"]) if (experiments.includes(name)) info.experiments = [...(info.experiments ?? []), name];
        wrap(WorkspaceSync.prototype, "receive", function (original, [message, reply, from]) {
          if (from && message?.kind === "hello") trace({ e: "hello-in", peer: from, reply: !!message.reply, ask: message.ask ?? null, since: !!message.since });
          else if (from && message?.kind === "commits") trace({ e: "commits-in", peer: from, n: Array.isArray(message.commits) ? message.commits.length : 0, fwd: !!message.fwd });
          return original.call(this, message, reply, from);
        });
        wrap(WorkspaceSync.prototype, "applyRooms", function (original, [want, member]) {
          const text = `${member ?? "-"} ${[...want].map(([key, spec]) => `${key}:${spec.passive ? "p" : "a"}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(",")}`;
          if (text !== this.__mwtRooms) trace({ e: "rooms-want", want: text, was: this.__mwtRooms ?? null });
          this.__mwtRooms = text;
          return original.call(this, want, member);
        });
        const routesKind = (list) => (list?.ask ? "ask" : Array.isArray(list?.routes) ? "full" : typeof list?.base === "number" ? "change" : "same");
        const routesSize = (list) => (Array.isArray(list?.routes) ? list.routes.length : (list?.add?.length ?? 0) + (list?.remove?.length ?? 0));
        // Ignoring lists, it still answers a peer asking for its own: the experiment changes only what this one takes.
        wrap(Mesh.prototype, "receiveRoutes", function (original, [peer, list]) {
          const ignored = noRoutes && !list?.ask;
          trace({ e: "routes-in", peer, kind: routesKind(list), n: list?.n ?? null, size: routesSize(list), ignored });
          if (ignored) return;
          return original.call(this, peer, list);
        });
        wrap(Mesh.prototype, "askRoutes", function (original, [peer]) {
          const before = this.asked.get(peer);
          const result = original.call(this, peer);
          if (this.asked.get(peer) !== before) trace({ e: "routes-ask", peer });
          return result;
        });
        wrap(Mesh.prototype, "addPhysical", function (original, [target, stream, meta, reason]) {
          if (!this.physical.get(target)?.get(stream)?.size) trace({ e: "place+", target, for: reason, kind: meta?.kind ?? null, stream: stream?.id?.slice(0, 8) ?? null });
          return original.call(this, target, stream, meta, reason);
        });
        wrap(Mesh.prototype, "removePhysical", function (original, [target, stream, reason]) {
          const reasons = this.physical.get(target)?.get(stream);
          if (reasons?.has(reason) && reasons.size === 1) trace({ e: "place-", target, for: reason, stream: stream?.id?.slice(0, 8) ?? null });
          return original.call(this, target, stream, reason);
        });
        wrap(NodeLink.prototype, "forget", function (original, [peer]) {
          if (this.peers.has(peer)) trace({ e: "node-forget", peer, user: this.peers.get(peer).user });
          return original.call(this, peer);
        });
        wrap(NodeLink.prototype, "receivePong", function (original, [ping, peer]) {
          const quiet = this.silent.has(peer);
          const result = original.call(this, ping, peer);
          if (quiet && !this.silent.has(peer)) trace({ e: "node-back", peer });
          return result;
        });
        wrap(VoiceLink.prototype, "callsNodeChanged", function (original, [mode]) {
          trace({ e: "mode", mode });
          return original.call(this, mode);
        });
        wrap(VoiceLink.prototype, "route", function (original, args) {
          const before = new Map([...this.sent].map(([peer, kinds]) => [peer, [...kinds.keys()].join("+")]));
          const result = original.apply(this, args);
          for (const [peer, kinds] of this.sent) {
            const now = [...kinds.keys()].join("+");
            if ((before.get(peer) ?? "") !== now) trace({ e: "sending", peer, user: this.peerUsers.get(peer), now, was: before.get(peer) ?? "" });
          }
          return result;
        });
        wrap(VoiceLink.prototype, "receiveStream", function (original, [peer, stream, meta]) {
          trace({ e: "stream-in", peer, kind: meta?.kind ?? null, stream: stream?.id?.slice(0, 8) ?? null, tracks: stream?.getTracks?.().length ?? 0 });
          return original.call(this, peer, stream, meta);
        });
        wrap(VoiceLink.prototype, "show", function (original, [peer]) {
          const user = this.peerUsers.get(peer);
          const micOf = () => (user === undefined ? null : media.remoteStream(this.workspaceId, user, "mic")?.id ?? null);
          const before = micOf();
          const result = original.call(this, peer);
          const after = micOf();
          if (before !== after) trace({ e: "mic-shown", peer, user, stream: after?.slice(0, 8) ?? null, was: before?.slice(0, 8) ?? null });
          return result;
        });
        // Commit batches and the hellos sent through `sendRoom`: the timer's (`reply: true`), and those on a new catch-up
        // source. Not the hello on connect or the answer to a hello (the constructor's own `send`); the other side
        // traces those as "hello-in". "norecheck" drops every `reply: true` hello while in a call: the timer's, and the
        // rare one after a room secret handoff. Every route list goes out through `sendRouteList` (whole, change,
        // "nothing changed", ask).
        W.traceCall = () => {
          let wrapped = 0;
          for (const sync of W.syncs.values()) {
            const mesh = sync.mesh;
            const sendList = mesh?.sendRouteList;
            if (typeof sendList === "function" && !sendList.__mwtCall) {
              mesh.sendRouteList = (list, peer) => {
                trace({ e: "routes-out", peer, kind: routesKind(list), n: list?.n ?? null, size: routesSize(list) });
                return sendList(list, peer);
              };
              mesh.sendRouteList.__mwtCall = true;
            }
            const send = sync.sendRoom;
            if (typeof send !== "function" || send.__mwtCall) continue;
            sync.sendRoom = (message, peer) => {
              if (message?.kind === "hello") {
                const skip = noRecheck && message.reply === true && sync.call !== null;
                trace({ e: skip ? "hello-skipped" : "hello-out", peer, reply: !!message.reply, ask: message.ask ?? null, since: !!message.since });
                if (skip) return Promise.resolve(true);
              } else if (message?.kind === "commits") trace({ e: "commits-out", peer, n: message.commits?.length ?? 0, fwd: !!message.fwd });
              return send(message, peer);
            };
            sync.sendRoom.__mwtCall = true;
            wrapped++;
          }
          return wrapped;
        };
        info.callHold = true;
      } catch (e) {
        info.callHoldError = String(e?.message ?? e);
      }
      // The presence a link sends (a closure made in its constructor): to one peer (how: direct or through which
      // go-between) or to everyone (whom that reaches).
      W.traceVoice = async () => {
        const media = await import("/src/voice/media.ts");
        let wrapped = 0;
        for (const sid of W.syncs.keys()) {
          const link = media.mediaLink(sid);
          if (!link || typeof link.sendPresence !== "function" || link.sendPresence.__mwtVoice) continue;
          const send = link.sendPresence;
          const mesh = link.mesh;
          link.sendPresence = (presence, peer) => {
            const ch = presence?.row ? Number(presence.row.channel_id) : null;
            if (peer) trace({ e: "send", to: peer, ch, how: mesh?.direct?.has(peer) ? "direct" : mesh?.via?.get(peer) ?? "unreachable", authorized: !!link.sync?.room?.isMember?.(peer) });
            else trace({ e: "send-all", ch, direct: Object.keys(link.sync?.room?.getPeers?.() ?? {}), via: Object.fromEntries(mesh?.via ?? []) });
            return send(presence, peer);
          };
          link.sendPresence.__mwtVoice = true;
          wrapped++;
        }
        return wrapped;
      };
      await W.traceVoice();
      info.voice = true;
    } catch (e) {
      info.voiceError = String(e?.message ?? e);
    }
    W.patched = Boolean(info.sync && info.ledger);
    W.patchInfo = info;
    return info;
  };
  // Page load while a phase runs (s14 call load): frames and the longest gap between them, long tasks, and DOM changes
  // (attributes, and style changes of the speaking dots), from loadStart() to loadRead().
  W.loadStart = () => {
    W.loadStop?.();
    const load = { since: performance.now(), frames: 0, maxGapMs: 0, longTasks: 0, longTaskMs: 0, mutations: 0, dotStyles: 0 };
    let last = performance.now();
    let frame = requestAnimationFrame(function count(now) {
      load.frames++;
      load.maxGapMs = Math.max(load.maxGapMs, now - last);
      last = now;
      frame = requestAnimationFrame(count);
    });
    let tasks = null;
    try {
      tasks = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          load.longTasks++;
          load.longTaskMs += entry.duration;
        }
      });
      tasks.observe({ type: "longtask", buffered: false });
    } catch {}
    const dom = new MutationObserver((records) => {
      for (const record of records) {
        load.mutations++;
        if (record.attributeName === "style" && record.target?.classList?.contains("voice-dot")) load.dotStyles++;
      }
    });
    dom.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
    W.loadStop = () => {
      cancelAnimationFrame(frame);
      tasks?.disconnect();
      dom.disconnect();
      W.loadStop = null;
    };
    W.load = load;
    return true;
  };
  W.loadRead = () => {
    const load = W.load;
    if (!load) return null;
    const seconds = (performance.now() - load.since) / 1000;
    return {
      seconds, fps: load.frames / seconds, maxGapMs: Math.round(load.maxGapMs), longTasks: load.longTasks,
      longTaskMs: Math.round(load.longTaskMs), mutationsPerS: load.mutations / seconds, dotStylesPerS: load.dotStyles / seconds,
    };
  };
  // Online drift (s17): everything that can pile up while a peer stays connected, as counts. Cumulative counters
  // (timeouts made, frames asked for, data channel frames by action) are read as totals; the harness takes differences.
  // App objects (the workspace's sync, its RoomGroup and Trystero rooms, mesh, ledger, and the presence, voice and
  // content links, found by wrapping a method each runs often) report the size of every Map, Set and Array they hold,
  // and for Maps of collections the total inside too ("name*").
  const links = (W.links ??= new Map());
  W.trackLinks = async () => {
    const wrap = (proto, method, kind) => {
      const original = proto?.[method];
      if (typeof original !== "function" || original.__mwtLink) return;
      const wrapped = function (...args) {
        try {
          const sid = this.workspaceId ?? this.ledger?.workspaceId ?? this.sync?.ledger?.workspaceId ?? "?";
          (links.get(sid) ?? links.set(sid, new Map()).get(sid)).set(kind, this);
        } catch {}
        return original.apply(this, args);
      };
      wrapped.__mwtLink = true;
      proto[method] = wrapped;
    };
    const tries = [
      ["/src/p2p/presence.ts", "PresenceChannel", ["publish", "set", "close"], "presence"],
      ["/src/p2p/voice.ts", "VoiceLink", ["heal"], "voice"],
      ["/src/p2p/content.ts", "ContentLink", ["ensureContent"], "content"],
      ["/src/p2p/nodes.ts", "NodeLink", ["pingAll"], "nodes"],
    ];
    for (const [file, name, methods, kind] of tries) {
      try {
        const mod = await import(file);
        for (const method of methods) wrap(mod[name]?.prototype, method, kind);
      } catch {}
    }
    // Calls counted (census `events`): how often the mesh, the rooms and the voice link react to connections.
    const counted = [
      ["/src/p2p/mesh.ts", "Mesh", ["peerJoined", "peerLeft", "peerMoved", "peerMember", "noteFailure", "place", "replacePhysical", "update", "receiveList"]],
      ["/src/p2p/roomGroup.ts", "RoomGroup", ["add", "remove", "drop", "authorizePeer"]],
      ["/src/p2p/sync.ts", "WorkspaceSync", ["receive", "checkRooms", "applyRooms", "setSource", "catchUp"]],
      ["/src/p2p/voice.ts", "VoiceLink", ["receive", "takePresence", "route", "receiveStream", "sendPresence"]],
      ["/src/p2p/presence.ts", "PresenceChannel", ["publish", "flush"]],
    ];
    for (const [file, name, methods] of counted) {
      try {
        const proto = (await import(file))[name]?.prototype;
        for (const method of methods) {
          const original = proto?.[method];
          if (typeof original !== "function" || original.__mwtCount) continue;
          const key = `${name}.${method}`;
          const wrapped = function (...args) {
            note(key);
            return original.apply(this, args);
          };
          wrapped.__mwtCount = true;
          // Keep other wraps' markers (W.patch tags its own with __mwt).
          if (original.__mwt) wrapped.__mwt = true;
          proto[method] = wrapped;
        }
      } catch {}
    }
    return true;
  };
  const sizesOf = (obj, depth = 0) => {
    const out = {};
    if (!obj || typeof obj !== "object") return out;
    for (const key of Object.getOwnPropertyNames(obj)) {
      let v;
      try {
        v = obj[key];
      } catch {
        continue;
      }
      if (v instanceof Map || v instanceof Set) {
        out[key] = v.size;
        let inner = 0;
        let any = false;
        for (const x of v.values()) {
          if (x instanceof Map || x instanceof Set) { inner += x.size; any = true; }
          else if (Array.isArray(x)) { inner += x.length; any = true; }
          else if (x && typeof x === "object" && Array.isArray(x.queue)) { inner += x.queue.length; any = true; }
        }
        if (any) out[`${key}*`] = inner;
      } else if (Array.isArray(v)) out[key] = v.length;
      else if (v instanceof WeakMap || v instanceof WeakSet || typeof v === "function") continue;
    }
    return out;
  };
  W.census = () => {
    const c = census;
    const intervals = {};
    for (const site of c.intervals.values()) intervals[site] = (intervals[site] ?? 0) + 1;
    const listeners = {};
    for (const [key, n] of c.listeners) if (n > 0) listeners[key] = n;
    c.channels = c.channels.filter((ch) => ch.readyState !== "closed");
    const channels = {};
    for (const ch of c.channels) channels[`${ch.label}:${ch.readyState}`] = (channels[`${ch.label}:${ch.readyState}`] ?? 0) + 1;
    const pcs = {};
    const now = Date.now();
    let neverConnected = 0;
    let oldestNeverConnectedS = 0;
    for (const r of W.pcs) {
      if (r.closedAt) continue;
      pcs[r.state] = (pcs[r.state] ?? 0) + 1;
      if (!r.connectedAt) {
        neverConnected++;
        oldestNeverConnectedS = Math.max(oldestNeverConnectedS, Math.round((now - r.created) / 1000));
      }
    }
    let wsOpen = 0;
    const ws = {};
    for (const [url, r] of Object.entries(W.ws)) {
      wsOpen += r.opens - r.closes;
      ws[url.replace(/^wss?:\/\//, "")] = { open: r.opens - r.closes, created: r.created, in: r.framesIn, out: r.framesOut, eventsIn: r.eventsIn, eventsOut: r.eventsOut, reqs: r.reqs };
    }
    const dc = { sent: {}, recv: {} };
    for (const side of ["sent", "recv"]) for (const [type, e] of Object.entries(W.dc[side])) dc[side][type] = { n: e.n, bytes: e.bytes };
    const app = {};
    for (const [sid, sync] of W.syncs) {
      const entry = (app[sid] = { sync: sizesOf(sync), room: sizesOf(sync.room), mesh: sizesOf(sync.mesh), ledger: sizesOf(sync.ledger) });
      const rooms = {};
      for (const [key, room] of sync.room?.rooms ?? []) {
        try {
          rooms[key] = Object.keys(room.getPeers?.() ?? {}).length;
        } catch {}
      }
      entry.trysteroRooms = rooms;
      for (const [kind, link] of links.get(sid) ?? []) entry[kind] = sizesOf(link);
    }
    const memory = performance.memory;
    return {
      t: Date.now(),
      heapMb: memory ? Math.round(memory.usedJSHeapSize / 1_048_576 * 10) / 10 : null,
      dom: document.getElementsByTagName("*").length,
      intervals, intervalCount: c.intervals.size, timeoutsPending: c.timeouts.size, timeoutsMade: c.timeoutsMade, framesAsked: c.frames,
      listeners, listenerCount: [...c.listeners.values()].reduce((a, b) => a + b, 0),
      channels, channelCount: c.channels.length, pcs, pcCount: Object.values(pcs).reduce((a, b) => a + b, 0), neverConnected, oldestNeverConnectedS,
      events: { ...c.events },
      wsOpen, ws, dc, app,
    };
  };
  // Call hold (s16), from holdStart(serverId) to holdStop(): every 100 ms the loudest each other call member's sound
  // got here (its player's analyser); every second those peaks (dBFS), the bytes received of each member's mic, every
  // open connection's states and audio and data bytes, which connection each room uses for each peer, and how this
  // member reaches each call peer. Read with holdRead(cursor).
  W.holdStart = async (serverId) => {
    W.holdStop?.();
    const voice = await import("/src/voice/state.ts");
    const remote = await import("/src/voice/remote.ts");
    const media = await import("/src/voice/media.ts");
    const { myId } = await import("/src/core/members.ts");
    const hold = (W.hold = { serverId, samples: [], base: 0 });
    const others = () => {
      const here = voice.call();
      if (!here || here.workspaceId !== serverId) return [];
      const me = myId(serverId);
      return voice.participants(serverId, here.channelId).map((p) => p.userId).filter((u) => u !== me);
    };
    let peaks = {};
    const fast = setInterval(() => {
      for (const user of others()) {
        const analyser = remote.remoteAnalyser(`${serverId}:${user}`);
        if (!analyser) continue;
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (const x of data) sum += x * x;
        const db = sum > 0 ? 10 * Math.log10(sum / data.length) : -120;
        peaks[user] = Math.max(peaks[user] ?? -120, db);
      }
    }, 100);
    let busy = false;
    const slow = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const t = Date.now();
        const users = others();
        const level = Object.fromEntries(users.map((u) => [u, peaks[u] === undefined ? null : Math.round(peaks[u])]));
        peaks = {};
        // Each member's mic as shown (its stream id) and its tracks, to find its receiver's bytes.
        const mic = {};
        const trackUser = {};
        for (const u of users) {
          const stream = media.remoteStream(serverId, u, "mic");
          mic[u] = stream ? stream.id.slice(0, 8) : null;
          for (const track of stream?.getAudioTracks() ?? []) trackUser[track.id] = u;
        }
        const micBytes = {};
        const byPc = {};
        for (const rec of W.pcs) {
          const pc = rec.pc;
          if (!pc || pc.connectionState === "closed") continue;
          const c = { s: pc.connectionState, ice: pc.iceConnectionState, aIn: 0, aOut: 0, dIn: 0, dOut: 0 };
          const report = await pc.getStats().catch(() => null);
          report?.forEach((s) => {
            if (s.type === "inbound-rtp" && s.kind === "audio") {
              c.aIn += s.bytesReceived ?? 0;
              const u = trackUser[s.trackIdentifier];
              if (u !== undefined) micBytes[u] = (micBytes[u] ?? 0) + (s.bytesReceived ?? 0);
            } else if (s.type === "outbound-rtp" && s.kind === "audio") c.aOut += s.bytesSent ?? 0;
            else if (s.type === "data-channel") {
              c.dIn += s.bytesReceived ?? 0;
              c.dOut += s.bytesSent ?? 0;
            }
          });
          byPc[rec.id] = c;
        }
        const sync = W.syncs.get(serverId);
        const rooms = {};
        for (const [key, room] of sync?.room?.rooms ?? []) {
          for (const [peer, pc] of Object.entries(room.getPeers?.() ?? {})) rooms[`${key}|${peer}`] = pc?.__mwtRec?.id ?? null;
        }
        const link = media.mediaLink(serverId);
        const mesh = sync?.mesh;
        const peers = {};
        for (const [peer, user] of link?.peerUsers ?? []) {
          if (!users.includes(user)) continue;
          peers[peer] = {
            user, direct: !!mesh?.direct?.has(peer), via: mesh?.via?.get(peer) ?? null, first: sync?.room?.peerRooms?.get(peer)?.[0] ?? null,
            sending: [...(link.sent?.get(peer)?.keys() ?? [])].join("+"),
          };
        }
        const mode = link?.sfu?.modeOf?.(voice.call()?.channelId ?? null) ?? null;
        hold.samples.push({ t, users, level, mic, micBytes, byPc, rooms, peers, mode, memberMode: sync?.memberMode ?? null });
        if (hold.samples.length > 7200) {
          hold.samples.shift();
          hold.base++;
        }
      } catch (e) {
        pushLog("warn", ["[mwt] hold sample failed", e]);
      } finally {
        busy = false;
      }
    }, 1000);
    W.holdStop = () => {
      clearInterval(fast);
      clearInterval(slow);
      W.holdStop = null;
    };
    return true;
  };
  // Samples from absolute index `cursor` on, and the next cursor.
  W.holdRead = (cursor = 0) => {
    const hold = W.hold;
    if (!hold) return { samples: [], next: cursor };
    const start = Math.max(0, cursor - hold.base);
    return { samples: hold.samples.slice(start), next: hold.base + hold.samples.length };
  };
  W.accSummary = (sid) => {
    const a = W.acc[sid];
    if (!a) return null;
    const { hashes, ...rest } = a;
    return { ...rest, ms: Math.round(rest.ms), replayMs: Math.round(rest.replayMs), unique: hashes.size };
  };
  W.countSeen = (sid, prefix) => {
    const seen = W.seen[sid];
    if (!seen) return 0;
    let n = 0;
    for (const tag in seen) if (tag.startsWith(prefix)) n++;
    return n;
  };
  W.rowIdsSince = (sid, prefix) => {
    const ids = W.rowIds[sid] ?? {};
    const out = {};
    for (const tag in ids) if (tag.startsWith(prefix)) out[tag] = ids[tag];
    return out;
  };
  W.seenSince = (sid, prefix) => {
    const seen = W.seen[sid] ?? {};
    const out = {};
    for (const tag in seen) if (tag.startsWith(prefix)) out[tag] = seen[tag];
    return out;
  };

  const startPatch = () => void W.patch().then(() => W.trackLinks()).catch((e) => pushLog("warn", ["[mwt] patch failed", e]));
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", startPatch, { once: true });
  else startPatch();
})();
