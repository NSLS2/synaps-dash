import 'server-only';
import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import {
  JWKS_URL,
  TOKEN_ENDPOINT,
  CLIENT_ID,
  CLIENT_SECRET,
  ENTRA_REFRESH_SKEW,
  TENANT_ID,
  entraUserScope,
} from './config';

// ---------------------------------------------------------------------------
// JWKS (cached automatically by jose)
// ---------------------------------------------------------------------------

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

// ---------------------------------------------------------------------------
// Code exchange
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for user identity + tokens.
 *
 * Mirrors: FastAPI app/utils/auth.py exchange_code_for_username()
 */
export async function exchangeCodeForUser(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  expectedNonce: string
): Promise<{
  username: string;
  displayName: string;
  accessToken: string;
  refreshToken: string | null;
}> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Entra token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const idToken: string = data.id_token;
  const accessToken: string = data.access_token;
  const refreshToken: string | null = data.refresh_token || null;

  // Verify id_token
  const { payload } = await jwtVerify(idToken, jwks, {
    algorithms: ['RS256'],
    audience: CLIENT_ID,
    issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
  });

  // Validate nonce
  if (payload.nonce !== expectedNonce) {
    throw new Error('id_token nonce mismatch');
  }

  const username = payload.sub;
  if (!username) {
    throw new Error('id_token missing sub claim');
  }

  const displayName =
    (payload.name as string) ||
    (payload.preferred_username as string) ||
    username;

  return { username, displayName, accessToken, refreshToken };
}

// ---------------------------------------------------------------------------
// Token expiry check
// ---------------------------------------------------------------------------

/**
 * Check if an Entra access token is close to expiry.
 * Decodes without verification (we only need the exp claim).
 *
 * Mirrors: FastAPI app/utils/auth.py is_entra_token_expiring()
 */
export function isEntraTokenExpiring(
  token: string,
  minTtlSeconds: number = ENTRA_REFRESH_SKEW
): boolean {
  try {
    const claims = decodeJwt(token);
    const exp = claims.exp;
    if (exp === undefined) return true;
    return Date.now() / 1000 > exp - minTtlSeconds;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Refresh an Entra access token using the refresh token.
 *
 * Mirrors: FastAPI app/utils/auth.py refresh_entra_access_token()
 */
export async function refreshEntraAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    scope: entraUserScope(),
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Entra token refresh failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
  };
}
