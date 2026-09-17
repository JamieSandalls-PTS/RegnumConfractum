import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ServerConfig {
  databaseUrl: string | undefined;
  port: number;
  adminPort: number;
  adminHost: string;
  adminToken: string | undefined;
  contentDir: string;
  /** Where new characters begin, and where every round opens: the tavern. */
  defaultAreaId: string;
  /**
   * The Round (D-521). ON by default (D-607), because the Round IS the
   * shipping target: a server that boots the persistent world boots the mode
   * that is not being shipped, and the only way to find that out is to log in
   * and notice nothing happens. `ROUND_MODE=0` gets the persistent world back.
   */
  round: {
    enabled: boolean;
    lengthTicks: number | undefined;
    /** Lower this to 1 to walk a round alone while testing. */
    minCast: number | undefined;
    seed: string | undefined;
  };
  /**
   * Whether the lobby may conjure companions (D-540, D-607).
   *
   * ⚠ Off in production, and it must stay that way: this registers real
   * accounts and creates real characters on demand, so on a public server it
   * is an account-creation hole wearing a lobby button. On by default
   * everywhere else, because the go/no-go gate is one person playing a round
   * and the cast floor is three.
   */
  allowBots: boolean;
}

/** Reads .env (if present) into process.env without overriding real env vars. */
function loadDotEnv(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
    }
  } catch {
    // no .env — fine
  }
}

export function loadConfig(): ServerConfig {
  loadDotEnv();
  const roundMode = (process.env.ROUND_MODE ?? '1') !== '0';
  return {
    databaseUrl: process.env.DATABASE_URL,
    port: Number(process.env.PORT ?? 8080),
    adminPort: Number(process.env.ADMIN_PORT ?? 8081),
    // Loopback by default; set 0.0.0.0 in Docker (compose maps it to host
    // loopback) or behind Caddy on the VPS (D-111).
    adminHost: process.env.ADMIN_HOST ?? '127.0.0.1',
    adminToken: process.env.ADMIN_TOKEN,
    contentDir: process.env.CONTENT_DIR ?? resolve(process.cwd(), 'content'),
    // ⚠ The TAVERN, in both modes (D-608). A round opens in the Hanged
    // Ferryman — which since D-604 is the tavern in the middle of Ashfold,
    // one door off the square — because that is the room D-536's opening
    // truce describes ("you have all woken in the same place") and D-549
    // named as where every round starts. It was `round-town`, the open
    // square, which put the cast out in the road. DEFAULT_AREA_ID overrides.
    defaultAreaId: process.env.DEFAULT_AREA_ID ?? 'hanged-ferryman',
    round: {
      enabled: roundMode,
      lengthTicks: process.env.ROUND_LENGTH_TICKS
        ? Number(process.env.ROUND_LENGTH_TICKS)
        : undefined,
      minCast: process.env.ROUND_MIN_CAST ? Number(process.env.ROUND_MIN_CAST) : undefined,
      seed: process.env.ROUND_SEED,
    },
    allowBots: process.env.ALLOW_BOTS
      ? process.env.ALLOW_BOTS === '1'
      : process.env.NODE_ENV !== 'production',
  };
}
