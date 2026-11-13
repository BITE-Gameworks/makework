#!/usr/bin/env node
// Starts BOTS bot members in this container (one Node process each, ports BOT_PORT (9300) + i, names bot<BOT_BASE + i>,
// three digits; containers on the host's network, topology lan, each get their own BOT_PORT). A bot that exits is logged with its code and not restarted (the harness counts it as a crash); the
// container stays up while any bot runs.
import { spawn } from "node:child_process";

const count = Number(process.env.BOTS ?? 1);
const base = Number(process.env.BOT_BASE ?? 1);
const firstPort = Number(process.env.BOT_PORT ?? 9300);
let running = 0;
for (let i = 0; i < count; i++) {
  const name = `bot${String(base + i).padStart(3, "0")}`;
  const child = spawn(process.execPath, ["--trace-warnings", "/node/mwt-bot.mjs", "--port", String(firstPort + i), "--name", name], { stdio: ["ignore", "inherit", "inherit"] });
  running++;
  child.on("exit", (code, signal) => {
    console.error(`[bots] ${name} exited (${signal ?? code})`);
    if (--running === 0) process.exit(1);
  });
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
