import path from 'node:path';

export function getDatabaseUrl() {
  return (process.env.DATABASE_URL || '').trim() || 'file:./data/app.sqlite';
}

export function normalizeSqlitePath(rawPath) {
  if (rawPath.startsWith('//')) {
    return path.normalize(rawPath);
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), rawPath);
}
