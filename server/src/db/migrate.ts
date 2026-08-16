import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Minimal forward-only migration runner. Files are NNNN_name.sql, applied in
 * lexical order, each in its own transaction, recorded in schema_migrations.
 */
export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const { rows } = await pool.query<{ name: string }>('select name from schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      ran.push(file);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}
