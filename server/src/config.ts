import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ServerConfig {
  databaseUrl: string | undefined;
  port: number;
  adminPort: number;
  adminHost: string;
  adminToken: string | undefined;
  contentDir: string;
  /** Where new characters begin. The first slice starts them at the tavern. */
  defaultAreaId: string;
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
  return {
    databaseUrl: process.env.DATABASE_URL,
    port: Number(process.env.PORT ?? 8080),
    adminPort: Number(process.env.ADMIN_PORT ?? 8081),
    // Loopback by default; set 0.0.0.0 in Docker (compose maps it to host
    // loopback) or behind Caddy on the VPS (D-111).
    adminHost: process.env.ADMIN_HOST ?? '127.0.0.1',
    adminToken: process.env.ADMIN_TOKEN,
    contentDir: process.env.CONTENT_DIR ?? resolve(process.cwd(), 'content'),
    defaultAreaId: process.env.DEFAULT_AREA_ID ?? 'hanged-ferryman',
  };
}
