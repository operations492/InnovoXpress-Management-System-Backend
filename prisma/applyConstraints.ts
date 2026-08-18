import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { env } from '../src/config/env.js';

// Order matters — constraints.sql revokes privileges across the whole public
// schema, so anything that grants or defines policy must run after it.
// positions.sql calls public.is_ops_user(), which map.sql creates, so it must
// follow it.
const SQL_FILES = ['constraints.sql', 'chat.sql', 'map.sql', 'positions.sql', 'routes.sql'];

/**
 * Applies the SQL files in prisma/sql, in order.
 *
 * Uses `pg` directly rather than shelling out to psql, which is not installed on
 * a typical Windows dev machine. The SQL is idempotent, so re-running is safe.
 */
async function main() {
  const pool = new Pool({ connectionString: env.DIRECT_URL ?? env.DATABASE_URL });

  try {
    for (const name of SQL_FILES) {
      const file = path.join('prisma', 'sql', name);
      const sql = await readFile(file, 'utf8');

      console.log(`… applying ${file}`);
      await pool.query(sql);
      console.log(`✓ applied ${file}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Failed to apply constraints:', e);
  process.exit(1);
});
