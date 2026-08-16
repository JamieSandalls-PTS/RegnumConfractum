# Development quick-start

Prerequisites: **Node 22+**, **Docker** (for Postgres), git.

```bash
npm install
npm run db:up            # Postgres 16 in Docker, host port 5433
npm run dev:server       # game ws://localhost:8080, admin http://localhost:8081
```

Configuration comes from `.env` (copy `.env.example`) or real environment
variables. Migrations run automatically on server start; `npm run db:migrate`
runs them standalone.

## Verification — the only review that counts (D-114)

```bash
npm run typecheck        # strict TS across all packages
npm run validate:content # schemas + reachability on /content, fails CI when red
npm test                 # unit + simulation + bot tests
```

`npm test` runs everything. The Postgres-backed tests (restart survival,
DB-level atomicity, append-only log) need `DATABASE_URL` set — with the dev
database up:

```bash
DATABASE_URL=postgres://rc:rc@localhost:5433/regnum npm test
```

Without `DATABASE_URL` those tests **skip** (useful for a quick loop, not a
full verification). CI always runs them against a Postgres service.

## Layout

Single npm package, multiple source roots joined by `@rc/*` path aliases in
`tsconfig.json` (see D-501 for why there is no build step and no workspaces):

| Path | Contents |
|---|---|
| `shared/src` | wire protocol, content schemas, constants, RNG — the single source of truth (D-105) |
| `server/src` | deterministic sim (`game/`), stores (`store/`), WS gateway (`net/`), admin UI (`admin/`), migrations (`db/`) |
| `sim/` | headless bot client + invariant/determinism/persistence suites |
| `tools/` | content validator CLI |
| `content/` | versioned world data — areas, item templates (D-110) |

## The admin UI

`http://localhost:8081` — live world state (tick, connections, entities per
area) and the recent event log. Read-only. Set `ADMIN_TOKEN` to require a
token outside local dev.

## Deploying (single VPS, D-111)

`docker compose --profile server up -d --build` runs Postgres + server.
Caddy TLS and off-box nightly backups are part of the staging milestone —
not yet configured in this repo.
