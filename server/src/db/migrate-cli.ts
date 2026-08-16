import pg from 'pg';
import { loadConfig } from '../config';
import { migrate } from './migrate';

const config = loadConfig();
if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  const ran = await migrate(pool);
  console.log(ran.length === 0 ? 'up to date' : `applied: ${ran.join(', ')}`);
} finally {
  await pool.end();
}
