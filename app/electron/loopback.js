// A one-off loopback server for a sign-in in the system browser (the OAuth way for installed apps, RFC 8252): the
// first request to `path` that `accept` takes is answered with the sign-in page `page(url)` describes and ends it; `promise` resolves with that
// request's URL. `open(base, port)` runs once it listens (base is `http://127.0.0.1:<port>`, without a slash), to
// send the browser off. Nothing on another device can reach it, so only the browser on this computer finishes it.
import http from "node:http";
import { signInPage } from "./signInPage.js";

export function loopbackOnce({ path, accept, page, open, timeoutMs }) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    let done = false;
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (done || url.pathname !== path || !accept(url)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" })
        .end(signInPage(page(url)));
      finish();
      resolve(url);
    });
    const finish = () => {
      done = true;
      clearTimeout(timeout);
      server.close();
      server.closeAllConnections?.();
    };
    const fail = (e) => {
      if (done) return;
      finish();
      reject(e);
    };
    const timeout = setTimeout(() => fail(new Error("Sign-in took too long. Try again.")), timeoutMs);
    cancel = () => fail(new Error("Sign-in was cancelled."));
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      try {
        open(`http://127.0.0.1:${port}`, port);
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
  return { promise, cancel: () => cancel() };
}
