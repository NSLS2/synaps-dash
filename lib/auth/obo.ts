import 'server-only';
import { TOKEN_ENDPOINT, CLIENT_ID, CLIENT_SECRET, TILED_SCOPE } from './config';
import { getFreshEntraToken } from './token-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OboTokenEntry {
  token: string;
  expiresAt: number; // Unix ms
  lastUsedAt: number; // Unix ms
}

// ---------------------------------------------------------------------------
// In-process OBO token cache (keyed by `${username}:${scope}`)
// ---------------------------------------------------------------------------

const OBO_CACHE_BUFFER_MS = 60_000; // Evict 1 min before actual expiry
const oboCacheKey = '__oboCacheStore';
const oboCacheLastCleanupKey = '__oboCacheLastCleanup';

function oboCacheMaxEntries(): number {
  const raw = Number(process.env.OBO_CACHE_MAX_ENTRIES ?? 2000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000;
}

function oboCacheCleanupIntervalMs(): number {
  const raw = Number(process.env.OBO_CACHE_CLEANUP_INTERVAL_MS ?? 60_000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
}

function getOboCache(): Map<string, OboTokenEntry> {
  const g = globalThis as Record<string, unknown>;
  if (!g[oboCacheKey]) {
    g[oboCacheKey] = new Map<string, OboTokenEntry>();
  }
  return g[oboCacheKey] as Map<string, OboTokenEntry>;
}

function isEntryUsable(entry: OboTokenEntry, now: number): boolean {
  return now < entry.expiresAt - OBO_CACHE_BUFFER_MS;
}

function removeExpiredEntries(cache: Map<string, OboTokenEntry>, now: number): void {
  for (const [key, entry] of cache.entries()) {
    if (!isEntryUsable(entry, now)) {
      cache.delete(key);
    }
  }
}

function enforceCacheSizeLimit(cache: Map<string, OboTokenEntry>): void {
  const maxEntries = oboCacheMaxEntries();
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function maybeRunCacheCleanup(cache: Map<string, OboTokenEntry>, now: number): void {
  const g = globalThis as Record<string, unknown>;
  const lastCleanup = (g[oboCacheLastCleanupKey] as number | undefined) ?? 0;
  if (now - lastCleanup < oboCacheCleanupIntervalMs()) {
    return;
  }

  g[oboCacheLastCleanupKey] = now;
  removeExpiredEntries(cache, now);
  enforceCacheSizeLimit(cache);
}

function touchCacheEntry(
  cache: Map<string, OboTokenEntry>,
  key: string,
  entry: OboTokenEntry,
  now: number
): void {
  const updated: OboTokenEntry = {
    ...entry,
    lastUsedAt: now,
  };

  // Reinsert to refresh insertion order for LRU-style eviction.
  cache.delete(key);
  cache.set(key, updated);
}

// ---------------------------------------------------------------------------
// OBO exchange
// ---------------------------------------------------------------------------

/**
 * Exchange an Entra access token for a Tiled-scoped token via OBO.
 *
 * Mirrors: FastAPI app/utils/auth.py exchange_token_obo()
 */
async function exchangeTokenObo(
  entraAccessToken: string
): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    assertion: entraAccessToken,
    requested_token_use: 'on_behalf_of',
    scope: TILED_SCOPE,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OBO token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    expires_in: data.expires_in || 3600, // Default 1hr if not specified
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a valid OBO token for a user, using cache when possible.
 *
 * Flow:
 * 1. Check cache for non-expired entry -> return if valid
 * 2. Get fresh Entra token (auto-refreshes if needed)
 * 3. Exchange for Tiled-scoped OBO token
 * 4. Cache the result
 * 5. Return the token
 */
export async function getOboTokenForUser(
  username: string,
  sessionId: string
): Promise<string> {
  const cache = getOboCache();
  const cacheKey = `${username}:${sessionId}:${TILED_SCOPE}`;
  const now = Date.now();

  maybeRunCacheCleanup(cache, now);

  const cached = cache.get(cacheKey);
  if (cached && isEntryUsable(cached, now)) {
    touchCacheEntry(cache, cacheKey, cached, now);
    return cached.token;
  }

  if (cached) {
    cache.delete(cacheKey);
  }

  // Get a fresh Entra token for this user
  const entraToken = await getFreshEntraToken(username, sessionId);

  // Exchange for Tiled token
  const oboResult = await exchangeTokenObo(entraToken);
  const cachedAt = Date.now();

  // Cache it
  cache.set(cacheKey, {
    token: oboResult.access_token,
    expiresAt: cachedAt + oboResult.expires_in * 1000,
    lastUsedAt: cachedAt,
  });
  enforceCacheSizeLimit(cache);

  return oboResult.access_token;
}

/**
 * Clear a user's OBO cache entry (e.g., on logout).
 */
export function clearOboCache(username: string): void {
  const cache = getOboCache();
  const cacheKey = `${username}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(cacheKey)) {
      cache.delete(key);
    }
  }
}

/**
 * Clear a user's OBO cache entry for a specific session.
 */
export function clearOboCacheForSession(username: string, sessionId: string): void {
  const cache = getOboCache();
  const cacheKey = `${username}:${sessionId}:${TILED_SCOPE}`;
  cache.delete(cacheKey);
}
