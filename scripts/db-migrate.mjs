import fs from 'node:fs';
import path from 'node:path';
import knex from 'knex';

function getDatabaseUrl() {
  return (process.env.DATABASE_URL || '').trim() || 'file:./data/app.sqlite';
}

function normalizeSqlitePath(rawPath) {
  if (rawPath.startsWith('//')) {
    return path.normalize(rawPath);
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  return path.resolve(process.cwd(), rawPath);
}

function createSqliteClient(databaseUrl) {
  const raw = databaseUrl.slice('file:'.length);
  const filename = raw
    ? normalizeSqlitePath(raw)
    : path.resolve(process.cwd(), 'data/app.sqlite');

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

async function migrate(db) {
  const tableName = 'entra_credentials';
  const exists = await db.schema.hasTable(tableName);
  if (!exists) {
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
