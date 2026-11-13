// Uploading a release file from disk to its host, against a local HTTP server standing in for GitHub or GitLab.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uploadAsset } from "../../electron/release.js";

let server: http.Server;
let base: string;
let received: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[];
let status = 201;
let file: string;

beforeEach(async () => {
  received = [];
  status = 201;
  server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(status < 300 ? { message: "201 Created" } : { message: "403 Forbidden" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mw-upload-")), "tool.zip");
  fs.writeFileSync(file, "zip bytes");
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("uploading a release file", () => {
  it("sends the file with the target's method and headers", async () => {
    const progress: number[] = [];
    await uploadAsset({
      target: { method: "PUT", url: `${base}/api/v4/projects/team%2Fapp/packages/generic/app/v2.0.0/tool.zip`, headers: { "PRIVATE-TOKEN": "t" } },
      file, name: "tool.zip", onProgress: (done: number) => progress.push(done),
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "PUT", url: "/api/v4/projects/team%2Fapp/packages/generic/app/v2.0.0/tool.zip", body: "zip bytes" });
    expect(received[0].headers).toMatchObject({ "private-token": "t", "content-type": "application/octet-stream", "content-length": "9" });
    expect(progress.at(-1)).toBe(1);
  });

  it("names the file and the host's answer when it refuses", async () => {
    status = 403;
    await expect(uploadAsset({ target: { method: "POST", url: `${base}/upload?name=tool.zip`, headers: {} }, file, name: "tool.zip" }))
      .rejects.toThrow("Uploading tool.zip failed (403): 403 Forbidden");
  });
});
