# fleet-manager

VDA5050 fleet manager. Bun monorepo (`packages/*`, `workspace:*`). Bun, never npm.

## Map

- `core` — runtime-agnostic logic: `Bus` interface, SRP (`js-srp6a`, standard params only), zod configs (`users.json`, sites), graferse traffic locks. No I/O.
- `transport-memory` — in-memory `Bus` (demo, tests). `transport-mqtt` — `mqtt.js` `Bus` (real robots).
- `vda` — `vda-5050-lib` wiring: `bootSiteFleet` (master + locks + dispatcher), memory or MQTT transport, `watchRobots` (single implementation — do not duplicate).
- `server` — Elysia REST + SSE (`/api/*`, Treaty type `FleetApi`). Sessions in SQLite (`SESSIONS_FILE`), TTL + boot purge.
- `ui` — Vite React ops UI. Talks to the server only through the `Backend` seam (`src/backend.ts`); `BackendMemory` (demo) is the other impl. Never bypass it.
- `demo` — serverless playground: real `App` + in-memory backend + wrangler panel. Reuse `ui` components; do not fork them.
- `cli` — `fleet users add`, `fleet spawn` (virtual robots against a broker).

Deps flow one way: `ui → server` types only, everything → `core`. `file:` overrides stay local, never committed.

## Commands

- `bun run dev` — API (:4000) + UI (:3000). Demo: `bun run dev` in `packages/demo` (:3001).
- `bun test packages/` — full suite. Slow/networked files hang foreground runners: run in background and read the log.
- `bun run typecheck` — must pass per package before commit.
- Seed login: `demo@fleet` / `fleet-demo`. Local broker: `BROKER_URL=mqtt://localhost:1883`, interface defaults to site name.

## Rules

- Small focussed commits, each with its tests green. One concern per commit.
- Fixes to an earlier commit go as `fixup!` commits (autosquash on rebase), not standalone `fix:` commits.
- Commit `bun.lock` in the same commit as the `package.json` change.
- Tests live next to code (`test/` per package), bun:test style. No DOM tests (logic only; JSX is wiring).
- SSE streams: baseline frame, heartbeat comments (Bun reaps idle connections), reader always cancelled.
- Elysia `onError` must set CORS headers — errors skip `onAfterHandle`.

## Traps

- SRP uses 4096-bit groups: auth tests take seconds each; flakes under parallel load are usually timing, rerun the file alone.
- `serve()` drops what it isn't given: check new options are forwarded (this bit us with `brokerUrl`).
- Old processes squat on `:4000` (a previous `fm-vda5050` master did for days) — `lsof -ti :4000` before believing errors.
- Sessions are in-memory unless `SESSIONS_FILE` is set; every restart logs everyone out otherwise.
