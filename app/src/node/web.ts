// The node's web server: an invite page per hosted server at the path its admin chose (`host --link`). Meant to sit
// behind a reverse proxy that adds HTTPS (Caddy, nginx).
import { createServer, type Server } from "node:http";
import { invitePage, notFoundPage, type InviteInfo } from "./page";
import { trimChars } from "../core/text";

export function startWeb(port: number, pageFor: (link: string) => InviteInfo | null): Server {
  const server = createServer((request, response) => {
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...headers, Allow: "GET, HEAD" }).end();
      return;
    }
    // The base only lets URL parse a bare path; nothing connects to it.
    const path = trimChars(new URL(request.url ?? "/", "https://node").pathname, "/");
    const info = path && /^[A-Za-z0-9_-]+$/.test(path) ? pageFor(path) : null;
    response.writeHead(info ? 200 : 404, headers);
    response.end(request.method === "HEAD" ? undefined : info ? invitePage(info) : notFoundPage());
  });
  server.listen(port, () => console.info(`Invite pages on http://localhost:${port}/<link>`));
  return server;
}
