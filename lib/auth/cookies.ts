import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, ACCESS_TOKEN_LIFETIME, REFRESH_TOKEN_LIFETIME } from './config';
import { decodeSessionToken } from './jwt';

// ---------------------------------------------------------------------------
// Set / clear session cookies
// ---------------------------------------------------------------------------

/**
 * Set session cookies on a NextResponse.
 * Mirrors: FastAPI app/utils/auth.py set_session_cookies()
 */
export function setSessionCookies(
  response: NextResponse,
  accessToken: string,
  refreshToken: string
): void {
  const isLocalhost = process.env.NODE_ENV === 'development';

  response.cookies.set(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    secure: !isLocalhost,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_LIFETIME,
  });

  response.cookies.set(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: !isLocalhost,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_TOKEN_LIFETIME,
  });
}

/**
 * Clear session cookies.
 * Mirrors: FastAPI app/utils/auth.py clear_session_cookies()
 */
export function clearSessionCookies(response: NextResponse): void {
  response.cookies.set(ACCESS_COOKIE, '', { path: '/', maxAge: 0 });
  response.cookies.set(REFRESH_COOKIE, '', { path: '/', maxAge: 0 });
}

// ---------------------------------------------------------------------------
// Read session from cookies
// ---------------------------------------------------------------------------

/**
 * Read and decode the session from request cookies.
 * Returns null if no valid session exists.
 */
export async function getSessionFromRequest(
  request: NextRequest
): Promise<{
  username: string;
  displayName: string;
  sessionId: string | null;
  source: 'access' | 'refresh';
} | null> {
  // Try access token first
  const accessCookie = request.cookies.get(ACCESS_COOKIE)?.value;
  if (accessCookie) {
    try {
      const payload = await decodeSessionToken(accessCookie, 'access');
      return {
        username: payload.sub,
        displayName: payload.name || payload.sub,
        sessionId: payload.sid || null,
        source: 'access',
      };
    } catch {
      // Access token invalid/expired -- try refresh below
    }
  }

  // Try refresh token
  const refreshCookie = request.cookies.get(REFRESH_COOKIE)?.value;
  if (refreshCookie) {
    try {
      const payload = await decodeSessionToken(refreshCookie, 'refresh');
      return {
        username: payload.sub,
        displayName: payload.name || payload.sub,
        sessionId: payload.sid || null,
        source: 'refresh',
      };
    } catch {
      // Refresh token also invalid
    }
  }

  return null;
}
