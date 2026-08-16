# Development quick-start

Prerequisites: **Node 22+**, **Docker** (for Postgres), git.

```bash
npm install
npm run db:up            # Postgres 16 in Docker, host port 5433
npm run dev:server       # game ws://localhost:8080, admin http://localhost:8081
npm run dev:client       # the game client — http://localhost:5173
```

Open http://localhost:5173 in two browser windows to see two characters in the
same world. Move with WASD/arrows; keys 1–4 toggle equipment on your own
character (debug, until the inventory drives it). **Enter** opens the chat
composer: `/w` whispers (1 tile), plain text speaks (10 tiles, line of sight),
`/y` shouts across the area. Text in `*asterisks*` animates via the emote
lexicon. The small **declare as…** field speaks the line under a name — yours
or anyone's; listeners' Insight may or may not see through it.

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

## The admin UI and DM console

`http://localhost:8081` — live world state (tick, connections, entities per
area), the recent event log, and the **DM console**: spawn an NPC, speak and
move as it (possession), narrate to an area or the world, change an area's
lighting. Set `ADMIN_TOKEN` to require a token outside local dev.

Area scripts are Lua files in `content/scripts/`, attached via the area's
`scripts` list — see `ferryman-keeper.lua` for the API in use. Transitions
between areas are declared per-area in content and validated in CI.

## Deploying (single VPS, D-111)

`docker compose --profile server up -d --build` runs Postgres + server.
Caddy TLS and off-box nightly backups are part of the staging milestone —
not yet configured in this repo.
