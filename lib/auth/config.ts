import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Token lifetimes (matching FastAPI app)
// ---------------------------------------------------------------------------
export const ACCESS_TOKEN_LIFETIME = 600; // 10 minutes (seconds)
export const REFRESH_TOKEN_LIFETIME = 86400; // 24 hours (seconds)
export const ENTRA_REFRESH_SKEW = 30; // Refresh Entra token 30s before expiry

// ---------------------------------------------------------------------------
// Cookie names (matching FastAPI app)
// ---------------------------------------------------------------------------
export const ACCESS_COOKIE = 'session_access_token';
export const REFRESH_COOKIE = 'session_refresh_token';

// ---------------------------------------------------------------------------
// Environment-derived constants
// ---------------------------------------------------------------------------
export const TENANT_ID = process.env.ENTRA_TENANT_ID ?? '';
export const CLIENT_ID = process.env.ENTRA_CLIENT_ID ?? '';
export const CLIENT_SECRET = process.env.ENTRA_CLIENT_SECRET ?? '';
export const SESSION_SECRET = process.env.SESSION_SECRET ?? '';
export const TILED_SCOPE = process.env.TILED_SCOPE ?? '';
export const APP_BASE_URL = process.env.APP_BASE_URL || null;
export const REDIRECT_ORIGIN_ALLOWLIST: string[] = (
  process.env.ENTRA_REDIRECT_ORIGIN_ALLOWLIST || ''
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Entra endpoints (derived from TENANT_ID)
// ---------------------------------------------------------------------------
export const AUTH_ENDPOINT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`;
export const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
export const JWKS_URL = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;

// ---------------------------------------------------------------------------
// Scopes requested during login
// ---------------------------------------------------------------------------
export function entraUserScope(): string {
  return `openid profile offline_access api://${CLIENT_ID}/access_as_user`;
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Throws at startup/first-use if required server env vars are missing.
 */
export function assertAuthConfig(): void {
  const missing: string[] = [];
  if (!TENANT_ID) missing.push('ENTRA_TENANT_ID');
  if (!CLIENT_ID) missing.push('ENTRA_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('ENTRA_CLIENT_SECRET');
  if (!SESSION_SECRET) missing.push('SESSION_SECRET');
  if (!TILED_SCOPE) missing.push('TILED_SCOPE');
  if (missing.length > 0) {
    throw new Error(
      `[auth/config] Missing required environment variables: ${missing.join(', ')}`
    );
  }
  if (SESSION_SECRET.length < 32) {
    throw new Error(
      '[auth/config] SESSION_SECRET must be at least 32 characters'
    );
  }
}

// ---------------------------------------------------------------------------
// Build callback URI from request origin
// ---------------------------------------------------------------------------

/**
 * Derive the OAuth callback URL from the incoming request.
 *
 * Uses X-Forwarded-Host / X-Forwarded-Proto when available (behind proxy),
 * otherwise falls back to the Host header or APP_BASE_URL.
 *
 * Only accepts NextRequest (used in API route handlers).
 */
export function buildCallbackUrl(request: NextRequest): string {
  const origin = resolveOrigin(request);
  return `${origin}/api/auth/entra/callback`;
}

function resolveOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const forwardedProtoRaw = request
    .headers.get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim()
    ?.toLowerCase();
  const forwardedProto =
    forwardedProtoRaw === 'http' || forwardedProtoRaw === 'https'
      ? forwardedProtoRaw
      : 'https';
  const host = forwardedHost || request.headers.get('host')?.split(',')[0]?.trim();

  if (host) {
    const requestProto = request.nextUrl.protocol?.replace(':', '').toLowerCase();
    const proto =
      forwardedHost
        ? forwardedProto
        : requestProto === 'http' || requestProto === 'https'
          ? requestProto
          : 'https';
    const origin = `${proto}://${host}`;

    // If allowlist is configured, validate
    if (REDIRECT_ORIGIN_ALLOWLIST.length > 0) {
      if (REDIRECT_ORIGIN_ALLOWLIST.includes(origin)) {
        return origin;
      }
      // Not in allowlist - fall through to APP_BASE_URL
    } else {
      return origin;
    }
  }

  if (APP_BASE_URL) {
    return APP_BASE_URL;
  }

  return 'http://localhost:3000';
}
