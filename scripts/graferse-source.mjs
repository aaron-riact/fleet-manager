#!/usr/bin/env node
/**
 * Point graferse at a local checkout, or back at the installed version.
 *
 *   bun run graferse:local [path]   default ../graferse
 *   bun run graferse:npm
 *
 * This is `npm link` by hand, put where bun will not shadow it. Nothing is
 * written to package.json or the lockfile, so there is no local edit to
 * forget about and nothing to keep out of a commit.
 *
 * Three approaches that do not work here, so nobody has to find out twice:
 *
 *   `bun link graferse` at the repo root
 *       lands in the root node_modules, which packages/core's own copy
 *       shadows. Run inside packages/core it hangs.
 *
 *   the checkout as a workspace member
 *       resolves correctly, but bun then owns the checkout's node_modules
 *       and strips the dependencies its own npm tooling needs.
 *
 *   a `file:` dependency
 *       bun hardlinks the files it saw at install time, so a file added in
 *       graferse later is simply missing until you reinstall. It also has to
 *       be committed, which breaks a clone without the sibling checkout.
 *
 * The symlink below is live: a file added in graferse appears at once.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "graferse";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [mode, checkout = `../${PACKAGE}`] = process.argv.slice(2);
if (mode !== "local" && mode !== "npm") {
  console.error(`usage: graferse-source.mjs local [path] | npm`);
  process.exit(1);
}

/** The workspace package that declares the dependency owns the resolution. */
function consumers() {
  const packages = path.join(root, "packages");
  return fs
    .readdirSync(packages)
    .map((name) => path.join(packages, name))
    .filter((dir) => {
      const manifest = path.join(dir, "package.json");
      if (!fs.existsSync(manifest)) return false;
      const { dependencies = {} } = JSON.parse(fs.readFileSync(manifest, "utf8"));
      return PACKAGE in dependencies;
    });
}

const found = consumers();
if (found.length === 0) {
  console.error(`no package under packages/ depends on ${PACKAGE}`);
  process.exit(1);
}

if (mode === "npm") {
  // whatever the lockfile says, reinstated
  execFileSync("bun", ["install", "--force"], { cwd: root, stdio: "inherit" });
  console.log(`\n${PACKAGE} now resolves to the installed version.`);
} else {
  const target = path.resolve(root, checkout);
  if (!fs.existsSync(path.join(target, "package.json"))) {
    console.error(`no package.json in ${target} — pass the checkout path as an argument`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(target, "node_modules"))) {
    console.error(`${target} has no node_modules — install its dependencies first`);
    process.exit(1);
  }
  for (const dir of found) {
    const link = path.join(dir, "node_modules", PACKAGE);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(path.relative(path.dirname(link), target), link);
    console.log(`${path.relative(root, link)} -> ${target}`);
  }
  console.log(`\n${PACKAGE} now resolves to ${target}, live.`);
  console.log(`run \`bun run ${PACKAGE}:npm\` (or any \`bun install\`) to undo.`);
}
