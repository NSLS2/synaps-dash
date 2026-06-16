import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import knex, { Knex } from 'knex';
import { getDatabaseUrl, normalizeSqlitePath } from './url-utils';

const globalKey = '__appDbClient';

function createSqliteClient(databaseUrl: string): Knex {
  const raw = databaseUrl.slice('file:'.length);
  const filePath = raw
    ? normalizeSqlitePath(raw)
    : path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'data/app.sqlite');

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  return knex({
    client: 'better-sqlite3',
    connection: {
      filename: filePath,
    },
    useNullAsDefault: true,
  });
}

function createDbClient(): Knex {
  const databaseUrl = getDatabaseUrl();

  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    return knex({
      client: 'pg',
      connection: databaseUrl,
      pool: {
        min: 0,
        max: 10,
      },
    });
  }

  if (databaseUrl.startsWith('file:')) {
    return createSqliteClient(databaseUrl);
  }

  throw new Error(
    `[db] Unsupported DATABASE_URL scheme. Expected postgres://, postgresql://, or file:, got: ${databaseUrl}`
  );
}

export function getDbClient(): Knex {
  const g = globalThis as Record<string, unknown>;
  if (!g[globalKey]) {
    g[globalKey] = createDbClient();
  }
  return g[globalKey] as Knex;
}
