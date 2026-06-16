import fs from 'node:fs';
import path from 'node:path';
import knex from 'knex';
import { getDatabaseUrl, normalizeSqlitePath } from '../lib/db/url-utils.mjs';

function createSqliteClient(databaseUrl) {
  const raw = databaseUrl.slice('file:'.length);
  const filename = normalizeSqlitePath(raw || './data/app.sqlite');

  fs.mkdirSync(path.dirname(filename), { recursive: true });

  return knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
  });
}

function createDbClient() {
  const databaseUrl = getDatabaseUrl();

  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    return knex({
      client: 'pg',
      connection: databaseUrl,
      pool: { min: 0, max: 10 },
    });
  }

  if (databaseUrl.startsWith('file:')) {
    return createSqliteClient(databaseUrl);
  }

  throw new Error(
    `[db:migrate] Unsupported DATABASE_URL scheme. Expected postgres://, postgresql://, or file:, got: ${databaseUrl}`
  );
}

function isTableAlreadyExistsError(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }

  if (err.code === '42P07') {
    return true;
  }

  if (typeof err.message === 'string') {
    const lower = err.message.toLowerCase();
    return (
      lower.includes('already exists') &&
      (lower.includes('table') || lower.includes('relation'))
    );
  }

  return false;
}

async function migrate(db) {
  const tableName = 'entra_credentials';
  const exists = await db.schema.hasTable(tableName);
  if (!exists) {
    try {
      await db.schema.createTable(tableName, (table) => {
        table.string('username').notNullable();
        table.string('session_id').notNullable();
        table.text('entra_access_token').notNullable();
        table.text('entra_refresh_token').nullable();
        table.bigInteger('stored_at').notNullable();
        table.bigInteger('updated_at').notNullable();
        table.bigInteger('last_used_at').notNullable();
        table.primary(['username', 'session_id']);
        table.index(['updated_at']);
        table.index(['last_used_at']);
      });
      console.log('[db:migrate] Created table:', tableName);
    } catch (err) {
      if (isTableAlreadyExistsError(err)) {
        console.log('[db:migrate] Table already exists (race-safe):', tableName);
      } else {
        throw err;
      }
    }
  } else {
    console.log('[db:migrate] Table already exists:', tableName);
  }
}

async function main() {
  const db = createDbClient();
  try {
    await migrate(db);
    console.log('[db:migrate] Complete');
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('[db:migrate] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
