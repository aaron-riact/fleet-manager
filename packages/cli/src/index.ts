#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { addUser, loadUsers, saveUsers } from "./users.js";
import { spawnRobot } from "./spawn.js";

const DEFAULT_FILE = new URL("../../../data/seed/users.json", import.meta.url).pathname;

function usage(): string {
  return [
    "fleet — fleet-manager CLI",
    "",
    "  fleet users add <username> [--sites a,b] [--password pw] [--file path]",
    "  fleet spawn --broker <url> --interface <name> --serial <id> [--x n] [--y n]",
    "",
    "Defaults: --sites coalescent, --file data/seed/users.json.",
    "Without --password, reads it interactively from stdin.",
    "spawn runs a virtual robot until Ctrl-C.",
  ].join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question("password: ", resolve));
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const [, , ...args] = process.argv;
  const [command, subject, ...rest] = args;
  if (command === "users" && subject === "add") {
    const takesValue = new Set(["--sites", "--password", "--file"]);
    const positionals: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg.startsWith("--")) {
        if (takesValue.has(arg)) i++;
        continue;
      }
      positionals.push(arg);
    }
    const username = positionals[0];
    if (!username) {
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    const file = flag(rest, "--file") ?? DEFAULT_FILE;
    const sites = (flag(rest, "--sites") ?? "coalescent").split(",");
    const password = flag(rest, "--password") ?? (await readPassword());
    const users = await addUser(loadUsers(file), { username, password, sites });
    saveUsers(file, users);
    console.log(`added ${username} (${sites.join(", ")}) -> ${file}`);
    return;
  }
  if (command === "spawn") {
    // spawn takes flags directly: fleet spawn --broker … (no subcommand)
    const flags = args.slice(1);
    const brokerUrl = flag(flags, "--broker");
    const interfaceName = flag(flags, "--interface");
    const serial = flag(flags, "--serial");
    if (!brokerUrl || !interfaceName || !serial) {
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    const x = flag(flags, "--x") ? Number(flag(flags, "--x")) : 0;
    const y = flag(flags, "--y") ? Number(flag(flags, "--y")) : 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      console.error("x and y must be numbers");
      process.exitCode = 2;
      return;
    }
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    console.log(`spawning ${serial} on ${interfaceName} via ${brokerUrl} (Ctrl-C to stop)`);
    await spawnRobot({ brokerUrl, interfaceName, serial, x, y, signal: controller.signal });
    console.log("stopped");
    return;
  }
  console.error(usage());
  process.exitCode = 2;
}

await main();
