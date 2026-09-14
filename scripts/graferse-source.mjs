#!/usr/bin/env node
/**
 * Point graferse at a local checkout, or back at the installed version.
 *
 *   bun run graferse:local [path]   default ../graferse
 *   bun run graferse:npm
 *
 * This wraps `bun link`, which is the supported way to develop against a
 * package you are also editing. Two steps:
 *
 *   1. `bun link` inside the checkout registers it, by the name in its
 *      package.json, in bun's global link directory
 *   2. `bun link <name> --cwd <consumer>` drops a symlink to it into that
 *      consumer's node_modules
 *
 * Both flags in step 2 are load bearing:
 *
 *   --cwd   must name the workspace package that DECLARES the dependency.
 *           Linked at the repo root the symlink lands in the root
 *           node_modules, where resolution never reaches it: node walks up
 *           from the importing file and finds packages/core/node_modules
 *           first. (Running bun link from inside that directory hangs, so
 *           reach it with --cwd from the root.)
 *
 *   --no-save  or bun writes "graferse": "link:graferse" into the consumer's
 *           package.json, which is a local edit you then have to remember not
 *           to commit.
 *
 * What makes this work where the alternatives do not: node_modules/graferse
 * becomes a symlink to the real directory, so every file is the live file -
 * a file added in graferse appears with no reinstall - and the checkout keeps
 * its own node_modules, so its own dependencies still resolve.
 *
 * A `file:` dependency fails both: bun hardlinks the files it saw at install
 * time, so a file added later is simply missing, and the path has to be
 * committed, which breaks a clone without the sibling checkout. Adding the
 * checkout as a workspace member fails the second: bun takes ownership of its
 * node_modules and strips the dependencies its own tooling needs.
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

const bun = (args, cwd) => execFileSync("bun", args, { cwd, stdio: "inherit" });

if (mode === "npm") {
  // a plain install replaces the symlink with what the lockfile says.
  // NOT --force: that re-resolves the whole tree and rewrites the lockfile
  // with unrelated hoisting churn.
  bun(["install"], root);
  console.log(`\n${PACKAGE} now resolves to the installed version.`);
  process.exit(0);
}

const target = path.resolve(root, checkout);
if (!fs.existsSync(path.join(target, "package.json"))) {
  console.error(`no package.json in ${target} — pass the checkout path as an argument`);
  process.exit(1);
}
if (!fs.existsSync(path.join(target, "node_modules"))) {
  console.error(`${target} has no node_modules — install its dependencies first`);
  process.exit(1);
}

/** The workspace package that declares the dependency owns the resolution. */
const consumers = fs
  .readdirSync(path.join(root, "packages"))
  .map((name) => path.join(root, "packages", name))
  .filter((dir) => {
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) return false;
    const { dependencies = {} } = JSON.parse(fs.readFileSync(manifest, "utf8"));
    return PACKAGE in dependencies;
  });

if (consumers.length === 0) {
  console.error(`no package under packages/ depends on ${PACKAGE}`);
  process.exit(1);
}

bun(["link"], target);
for (const dir of consumers) {
  bun(["link", PACKAGE, "--no-save", "--cwd", path.relative(root, dir)], root);
}

console.log(`\n${PACKAGE} now resolves to ${target}, live.`);
console.log(`run \`bun run ${PACKAGE}:npm\` (or any \`bun install\`) to undo.`);
