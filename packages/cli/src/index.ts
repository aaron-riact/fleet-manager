#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { addUser, loadUsers, saveUsers } from "./users.js";

const DEFAULT_FILE = new URL("../../../data/seed/users.json", import.meta.url).pathname;

function usage(): string {
  return [
    "fleet — fleet-manager CLI",
    "",
    "  fleet users add <username> [--sites a,b] [--password pw] [--file path]",
    "",
    "Defaults: --sites coalescent, --file data/seed/users.json.",
    "Without --password, reads it interactively from stdin.",
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
  const [, , command, subject, ...rest] = process.argv;
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
  console.error(usage());
  process.exitCode = 2;
}

await main();
