#!/usr/bin/env bun
/**
 * Boot the API with repo seed data. No required flags:
 *
 *   bun run serve          from packages/server, or
 *   bun run dev:server     from the repo root
 *
 * Env overrides: PORT (default 4000), USERS_FILE, SITES_DIR,
 * BROKER_URL (real broker; absent: memory bus), INTERFACE_NAME,
 * SESSIONS_FILE (default data/sessions.db), SESSION_TTL_HOURS (default 12),
 * TRUST_PROXY_HEADER=1 (only behind a proxy that sets X-Forwarded-For).
 * Defaults resolve from the repo root, so the cwd does not matter.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const port = Number(process.env.PORT ?? 4000);
const usersFile = process.env.USERS_FILE ?? join(root, "data/seed/users.json");
const sitesDir = process.env.SITES_DIR ?? join(root, "data/seed/sites");
const brokerUrl = process.env.BROKER_URL;
const interfaceName = process.env.INTERFACE_NAME;
const sessionsFile = process.env.SESSIONS_FILE ?? join(root, "data/sessions.db");
const trustProxyHeader = process.env.TRUST_PROXY_HEADER === "1";
const sessionTtlMs = process.env.SESSION_TTL_HOURS ? Number(process.env.SESSION_TTL_HOURS) * 3_600_000 : undefined;

const { port: actual } = await serve({ port, usersFile, sitesDir, brokerUrl, interfaceName, sessionsFile, sessionTtlMs, trustProxyHeader });
console.log(`fleet-manager server listening on http://localhost:${actual}`);
