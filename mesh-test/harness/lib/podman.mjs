// Controls the client containers through the rootless podman REST API (docker-compatible endpoints where they
// exist, libpod ones for stats). The socket is mounted into the harness container at $PODMAN_SOCK.
import http from "node:http";
import fs from "node:fs";

const compat = "/v1.41";
const libpod = "/v5.0.0/libpod";

// Docker's stream format without a TTY: [stream type, 0, 0, 0, size (4 bytes BE)] then the payload, repeated.
// Anything that doesn't parse as frames is taken as plain text.
function demux(buffer) {
  const out = { stdout: "", stderr: "", all: "" };
  let i = 0;
  while (i + 8 <= buffer.length) {
    const type = buffer[i];
    const size = buffer.readUInt32BE(i + 4);
    if (type > 2 || buffer[i + 1] !== 0 || i + 8 + size > buffer.length) return { stdout: buffer.toString("utf8"), stderr: "", all: buffer.toString("utf8") };
    const text = buffer.subarray(i + 8, i + 8 + size).toString("utf8");
    if (type === 2) out.stderr += text;
    else out.stdout += text;
    out.all += text;
    i += 8 + size;
  }
  return out;
}

export class Podman {
  constructor(socketPath = process.env.PODMAN_SOCK ?? "/run/podman/podman.sock") {
    this.socketPath = socketPath;
    this.available = fs.existsSync(socketPath);
    // Per container: the cumulative CPU time and the clock at the last stats() call.
    this.lastCpu = new Map();
  }

  request(method, path, body, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.socketPath, method, path, timeout: timeoutMs,
          headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {}
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(json ?? text);
            else reject(new Error(`podman ${method} ${path}: HTTP ${res.statusCode} ${text.slice(0, 300)}`));
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`podman ${method} ${path}: timeout`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // The raw response body (exec output and logs come multiplexed: 8-byte frame headers, see demux).
  rawRequest(method, path, body, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.socketPath, method, path, timeout: timeoutMs,
          headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(buffer);
            else reject(new Error(`podman ${method} ${path}: HTTP ${res.statusCode} ${buffer.toString("utf8").slice(0, 300)}`));
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`podman ${method} ${path}: timeout`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // Runs a command in a running container: { code, stdout, stderr }.
  async exec(name, cmd, timeoutMs = 60_000) {
    this.requireSocket();
    const created = await this.request("POST", `${compat}/containers/${encodeURIComponent(name)}/exec`, { AttachStdout: true, AttachStderr: true, Cmd: cmd });
    const raw = await this.rawRequest("POST", `${compat}/exec/${created.Id}/start`, { Detach: false, Tty: false }, timeoutMs);
    const info = await this.request("GET", `${compat}/exec/${created.Id}/json`);
    return { code: info?.ExitCode ?? null, ...demux(raw) };
  }

  // The container's output (stdout and stderr together, in order) since `since` (unix seconds).
  async logs(name, since = 0) {
    this.requireSocket();
    const raw = await this.rawRequest("GET", `${compat}/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&since=${since}`);
    return demux(raw).all;
  }

  requireSocket() {
    if (!this.available) throw new Error(`podman socket not found at ${this.socketPath}`);
  }

  async inspect(name) {
    this.requireSocket();
    return this.request("GET", `${compat}/containers/${encodeURIComponent(name)}/json`);
  }

  // { "<network>": "<ip>" } of a running container.
  async ips(name) {
    const info = await this.inspect(name);
    const nets = info?.NetworkSettings?.Networks ?? {};
    return Object.fromEntries(Object.entries(nets).map(([net, n]) => [net, n.IPAddress]));
  }

  async running(name) {
    const info = await this.inspect(name);
    return Boolean(info?.State?.Running);
  }

  async kill(name, signal = "KILL") {
    this.requireSocket();
    await this.request("POST", `${compat}/containers/${encodeURIComponent(name)}/kill?signal=${signal}`);
  }

  async start(name) {
    this.requireSocket();
    await this.request("POST", `${compat}/containers/${encodeURIComponent(name)}/start`);
  }

  async stop(name, timeoutS = 5) {
    this.requireSocket();
    await this.request("POST", `${compat}/containers/${encodeURIComponent(name)}/stop?t=${timeoutS}`);
  }

  async disconnect(network, container) {
    this.requireSocket();
    await this.request("POST", `${compat}/networks/${encodeURIComponent(network)}/disconnect`, { Container: container, Force: true });
  }

  // `ip`: the address it had, so CDP and the other members find it at the same place again.
  async connect(network, container, ip) {
    this.requireSocket();
    const body = { Container: container };
    if (ip) body.EndpointConfig = { IPAMConfig: { IPv4Address: ip } };
    await this.request("POST", `${compat}/networks/${encodeURIComponent(network)}/connect`, body);
  }

  // [{ name, cpu (percent), mem (bytes), memLimit, netIn, netOut }] for the named containers. `cpu` is the share of one
  // core since the previous call: a one-shot libpod sample's own `CPU` is the average since the container started (an
  // idle client showed 41% while it used 3%), so it only stands in for a container's first sample.
  async stats(names) {
    this.requireSocket();
    const query = names.map((n) => `containers=${encodeURIComponent(n)}`).join("&");
    const data = await this.request("GET", `${libpod}/containers/stats?stream=false&${query}`, undefined, 20_000);
    const list = data?.Stats ?? [];
    return list.map((s) => {
      const used = Number(s.CPUNano ?? 0);
      const at = Number(s.SystemNano ?? 0);
      const last = this.lastCpu.get(s.Name);
      this.lastCpu.set(s.Name, { used, at });
      const cpu = last && at > last.at && used >= last.used ? ((used - last.used) / (at - last.at)) * 100 : Number(s.CPU ?? 0);
      return {
        name: s.Name, cpu, mem: Number(s.MemUsage ?? 0), memLimit: Number(s.MemLimit ?? 0),
        netIn: Number(s.NetInput ?? 0), netOut: Number(s.NetOutput ?? 0), pids: Number(s.PIDs ?? 0),
      };
    });
  }
}
