import { TOKEN_ENDPOINT, CLIENT_ID, CLIENT_SECRET, TILED_SCOPE } from './config';
import { getFreshEntraToken } from './token-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OboTokenEntry {
  token: string;
  expiresAt: number; // Unix ms
}

// ---------------------------------------------------------------------------
// In-process OBO token cache (keyed by `${username}:${scope}`)
// ---------------------------------------------------------------------------

const OBO_CACHE_BUFFER_MS = 60_000; // Evict 1 min before actual expiry
const oboCacheKey = '__oboCacheStore';

function getOboCache(): Map<string, OboTokenEntry> {
  const g = globalThis as Record<string, unknown>;
  if (!g[oboCacheKey]) {
    g[oboCacheKey] = new Map<string, OboTokenEntry>();
  }
  return g[oboCacheKey] as Map<string, OboTokenEntry>;
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

  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - OBO_CACHE_BUFFER_MS) {
    return cached.token;
  }

  // Get a fresh Entra token for this user
  const entraToken = await getFreshEntraToken(username, sessionId);

  // Exchange for Tiled token
  const oboResult = await exchangeTokenObo(entraToken);

  // Cache it
  cache.set(cacheKey, {
    token: oboResult.access_token,
    expiresAt: Date.now() + oboResult.expires_in * 1000,
  });

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
