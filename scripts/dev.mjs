#!/usr/bin/env node
/**
 * Run the full local stack: API (:4000) + UI (:3000).
 *
 *   bun run dev
 *
 * Exits (stopping both) when either child exits; forwards SIGINT/SIGTERM.
 * The UI already defaults to VITE_API_BASE=http://localhost:4000, so no
 * extra configuration is needed for the default ports.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = new Set();
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}

function start(name, script, cwd) {
  const child = spawn("bun", ["run", script], { cwd, stdio: "inherit" });
  children.add(child);
  child.on("exit", (code, signal) => {
    console.log(`\ndev: ${name} exited (${signal ?? `code ${code}`}) — stopping the stack`);
    shutdown(signal ? 1 : (code ?? 1));
  });
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

start("server", "dev:server", root);
start("ui", "dev", path.join(root, "packages", "ui"));
