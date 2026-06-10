import { isEntraTokenExpiring, refreshEntraAccessToken } from './entra';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntraTokenEntry {
  entraAccessToken: string;
  entraRefreshToken: string | null;
  storedAt: number; // Date.now() when stored
}

// ---------------------------------------------------------------------------
// In-memory store (survives hot-reload in dev via globalThis)
// ---------------------------------------------------------------------------

const globalKey = '__entraTokenStore';

function getStore(): Map<string, EntraTokenEntry> {
  const g = globalThis as Record<string, unknown>;
  if (!g[globalKey]) {
    g[globalKey] = new Map<string, EntraTokenEntry>();
  }
  return g[globalKey] as Map<string, EntraTokenEntry>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getTokens(username: string): EntraTokenEntry | null {
  return getStore().get(username) ?? null;
}

export function setTokens(username: string, entry: EntraTokenEntry): void {
  getStore().set(username, entry);
}

export function deleteTokens(username: string): void {
  getStore().delete(username);
}

/**
 * Get a fresh (non-expired) Entra access token for a user.
 * If the stored token is expiring, refreshes it automatically.
 * If refresh fails, deletes the entry and throws.
 *
 * Mirrors: FastAPI app/utils/auth.py get_fresh_entra_access_token()
 */
export async function getFreshEntraToken(username: string): Promise<string> {
  const entry = getTokens(username);
  if (!entry) {
    throw new Error('No Entra credentials stored for user');
  }

  if (!isEntraTokenExpiring(entry.entraAccessToken)) {
    return entry.entraAccessToken;
  }

  // Token is expiring -- attempt refresh
  if (!entry.entraRefreshToken) {
    deleteTokens(username);
    throw new Error('Entra refresh token missing; re-authentication required');
  }

  try {
    const refreshed = await refreshEntraAccessToken(entry.entraRefreshToken);
    const updatedEntry: EntraTokenEntry = {
      entraAccessToken: refreshed.accessToken,
      entraRefreshToken: refreshed.refreshToken,
      storedAt: Date.now(),
    };
    setTokens(username, updatedEntry);
    return refreshed.accessToken;
  } catch (err) {
    deleteTokens(username);
    throw new Error(
      `Entra token refresh failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
