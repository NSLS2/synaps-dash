import fs from 'node:fs';
import path from 'node:path';
import knex, { Knex } from 'knex';

const globalKey = '__appDbClient';

function getDatabaseUrl(): string {
  return process.env.DATABASE_URL?.trim() || 'file:./data/app.sqlite';
}

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

function normalizeSqlitePath(rawPath: string): string {
  if (rawPath.startsWith('//')) {
    // file:// style absolute paths become //abs/path after stripping `file:`
    return path.normalize(rawPath);
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), rawPath);
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
