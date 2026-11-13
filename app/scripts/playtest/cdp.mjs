// Tiny CDP client: node cdp.mjs eval "<expression>" | shot <file.png> | click-text "<text>"
import { writeFileSync } from "node:fs";
const port = process.env.CDP_PORT || 9223;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "eval") {
  const r = await send("Runtime.evaluate", { expression: rest.join(" "), awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.log("EXCEPTION", JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails));
  else console.log(typeof r.result?.result?.value === "string" ? r.result.result.value : JSON.stringify(r.result?.result?.value));
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png", fromSurface: !process.env.NOSURFACE, captureBeyondViewport: false });
  writeFileSync(rest[0], Buffer.from(r.result.data, "base64"));
  console.log("saved", rest[0]);
}
else if (cmd === "click") {
  const [x, y] = rest.map(Number);
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  console.log("clicked", x, y);
}
ws.close();
