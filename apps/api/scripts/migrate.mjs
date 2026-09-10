import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const migrationsDir = path.resolve(process.cwd(), '../../infra/migrations');
const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const crypto = await import('node:crypto');
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort((a, b) => a.localeCompare(b));

  for (const filename of files) {
    const sql = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const existing = await client.query('select checksum from schema_migrations where filename=$1', [filename]);

    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Migration changed after apply: ${filename}`);
      }
      console.log(`skip ${filename}`);
      continue;
    }

    console.log(`apply ${filename}`);
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query(
        'insert into schema_migrations (filename, checksum) values ($1,$2)',
        [filename, checksum]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }

  console.log(`migrations complete (${files.length})`);
} finally {
  await client.end();
}
