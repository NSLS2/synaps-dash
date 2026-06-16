import {
  getDatabaseUrl as getDatabaseUrlUntyped,
  normalizeSqlitePath as normalizeSqlitePathUntyped,
} from './url-utils.mjs';

export function getDatabaseUrl(): string {
  return getDatabaseUrlUntyped();
}

export function normalizeSqlitePath(rawPath: string): string {
  return normalizeSqlitePathUntyped(rawPath);
}
