#!/usr/bin/env bun
/**
 * Boot the API with repo seed data. No required flags:
 *
 *   bun run serve          from packages/server, or
 *   bun run dev:server     from the repo root
 *
 * Env overrides: PORT (default 4000), USERS_FILE, SITES_DIR.
 * Defaults resolve from the repo root, so the cwd does not matter.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const port = Number(process.env.PORT ?? 4000);
const usersFile = process.env.USERS_FILE ?? join(root, "data/seed/users.json");
const sitesDir = process.env.SITES_DIR ?? join(root, "data/seed/sites");

const { port: actual } = await serve({ port, usersFile, sitesDir });
console.log(`fleet-manager server listening on http://localhost:${actual}`);
