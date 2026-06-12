import { isEntraTokenExpiring, refreshEntraAccessToken } from './entra';
import { getDbClient } from '@/lib/db/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntraTokenEntry {
  entraAccessToken: string;
  entraRefreshToken: string | null;
  storedAt: number; // Date.now() when stored
}

// ---------------------------------------------------------------------------
// Persistent store schema
// ---------------------------------------------------------------------------

const TABLE_NAME = 'entra_credentials';
const initKey = '__entraTokenStoreInit';
const cleanupIntervalMs = 60_000;
const lastCleanupKey = '__entraTokenStoreLastCleanup';

function maxAgeSeconds(): number {
  const raw = Number(process.env.ENTRA_CREDENTIALS_MAX_AGE_SECONDS ?? 7 * 24 * 60 * 60);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7 * 24 * 60 * 60;
}

function maxRows(): number {
  const raw = Number(process.env.ENTRA_CREDENTIALS_MAX_ROWS ?? 10_000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10_000;
}

async function ensureSchema(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  if (!g[initKey]) {
    g[initKey] = (async () => {
      const db = getDbClient();
      const exists = await db.schema.hasTable(TABLE_NAME);
      if (!exists) {
        await db.schema.createTable(TABLE_NAME, (table) => {
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
      }
    })();
  }
  await g[initKey];
}

async function runCleanupIfNeeded(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const now = Date.now();
  const lastRun = (g[lastCleanupKey] as number | undefined) ?? 0;
  if (now - lastRun < cleanupIntervalMs) {
    return;
  }

  g[lastCleanupKey] = now;
  const db = getDbClient();

  // TTL eviction
  const cutoff = now - maxAgeSeconds() * 1000;
  await db(TABLE_NAME)
    .where('updated_at', '<', cutoff)
    .delete();

  // Size eviction
  const [{ count }] = await db(TABLE_NAME).count<{ count: string | number }[]>({ count: '*' });
  const totalCount = Number(count);
  const limit = maxRows();
  if (!Number.isFinite(totalCount) || totalCount <= limit) {
    return;
  }

  const toDelete = totalCount - limit;
  const rows = await db(TABLE_NAME)
    .select('username', 'session_id')
    .orderBy('updated_at', 'asc')
    .limit(toDelete);

  if (rows.length > 0) {
    await db(TABLE_NAME)
      .whereIn(
        ['username', 'session_id'],
        rows.map((row) => [row.username as string, row.session_id as string])
      )
      .delete();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getTokens(
  username: string,
  sessionId: string
): Promise<EntraTokenEntry | null> {
  await ensureSchema();
  const db = getDbClient();
  const row = await db(TABLE_NAME)
    .select('entra_access_token', 'entra_refresh_token', 'stored_at')
    .where({ username, session_id: sessionId })
    .first();

  if (!row) {
    return null;
  }

  return {
    entraAccessToken: row.entra_access_token as string,
    entraRefreshToken: (row.entra_refresh_token as string | null) ?? null,
    storedAt: Number(row.stored_at),
  };
}

export async function setTokens(
  username: string,
  sessionId: string,
  entry: EntraTokenEntry
): Promise<void> {
  await ensureSchema();
  const db = getDbClient();
  const now = Date.now();

  await db(TABLE_NAME)
    .insert({
      username,
      session_id: sessionId,
      entra_access_token: entry.entraAccessToken,
      entra_refresh_token: entry.entraRefreshToken,
      stored_at: entry.storedAt,
      updated_at: now,
      last_used_at: now,
    })
    .onConflict(['username', 'session_id'])
    .merge({
      entra_access_token: entry.entraAccessToken,
      entra_refresh_token: entry.entraRefreshToken,
      stored_at: entry.storedAt,
      updated_at: now,
      last_used_at: now,
    });

  await runCleanupIfNeeded();
}

export async function deleteTokens(username: string, sessionId: string): Promise<void> {
  await ensureSchema();
  const db = getDbClient();
  await db(TABLE_NAME)
    .where({ username, session_id: sessionId })
    .delete();
}

/**
 * Get a fresh (non-expired) Entra access token for a user.
 * If the stored token is expiring, refreshes it automatically.
 * If refresh fails, deletes the entry and throws.
 *
 * Mirrors: FastAPI app/utils/auth.py get_fresh_entra_access_token()
 */
export async function getFreshEntraToken(
  username: string,
  sessionId: string
): Promise<string> {
  const entry = await getTokens(username, sessionId);
  if (!entry) {
    throw new Error('No Entra credentials stored for user');
  }

  if (!isEntraTokenExpiring(entry.entraAccessToken)) {
    const db = getDbClient();
    await db(TABLE_NAME)
      .where({ username, session_id: sessionId })
      .update({ last_used_at: Date.now() });
    return entry.entraAccessToken;
  }

  // Token is expiring -- attempt refresh
  if (!entry.entraRefreshToken) {
    await deleteTokens(username, sessionId);
    throw new Error('Entra refresh token missing; re-authentication required');
  }

  try {
    const refreshed = await refreshEntraAccessToken(entry.entraRefreshToken);
    const updatedEntry: EntraTokenEntry = {
      entraAccessToken: refreshed.accessToken,
      entraRefreshToken: refreshed.refreshToken,
      storedAt: Date.now(),
    };
    await setTokens(username, sessionId, updatedEntry);
    return refreshed.accessToken;
  } catch (err) {
    await deleteTokens(username, sessionId);
    throw new Error(
      `Entra token refresh failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
