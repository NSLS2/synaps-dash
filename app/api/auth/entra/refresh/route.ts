import { NextRequest, NextResponse } from 'next/server';
import { REFRESH_COOKIE, assertAuthConfig } from '@/lib/auth/config';
import { decodeSessionToken, issueSessionTokens } from '@/lib/auth/jwt';
import { setSessionCookies, clearSessionCookies } from '@/lib/auth/cookies';
import { deleteTokens, getTokens, setTokens } from '@/lib/auth/token-store';
import { isEntraTokenExpiring, refreshEntraAccessToken } from '@/lib/auth/entra';

export async function POST(request: NextRequest) {
  assertAuthConfig();

  const refreshCookie = request.cookies.get(REFRESH_COOKIE)?.value;

  if (!refreshCookie) {
    return NextResponse.json({ error: 'missing refresh token' }, { status: 401 });
  }

  let username: string;
  let displayName: string;
  let sessionId: string;

  try {
    const payload = await decodeSessionToken(refreshCookie, 'refresh');
    username = payload.sub;
    displayName = payload.name || username;
    sessionId = payload.sid || '';

    if (!sessionId) {
      const response = NextResponse.json(
        { error: 'invalid session token' },
        { status: 401 }
      );
      clearSessionCookies(response);
      return response;
    }
  } catch {
    const response = NextResponse.json({ error: 'invalid refresh token' }, { status: 401 });
    clearSessionCookies(response);
    return response;
  }

  // Try to refresh the underlying Entra token
  const entry = await getTokens(username, sessionId);
  if (!entry) {
    const response = NextResponse.json({ error: 'missing entra credentials' }, { status: 401 });
    clearSessionCookies(response);
    return response;
  }

  if (entry.entraRefreshToken) {
    try {
      const refreshed = await refreshEntraAccessToken(entry.entraRefreshToken);
      await setTokens(username, sessionId, {
        entraAccessToken: refreshed.accessToken,
        entraRefreshToken: refreshed.refreshToken,
        storedAt: Date.now(),
      });
    } catch (err) {
      console.error('[Entra Refresh] Failed:', err instanceof Error ? err.message : err);
      // Clear stored tokens on refresh failure
      await deleteTokens(username, sessionId);
      const response = NextResponse.json(
        { error: 'entra refresh failed' },
        { status: 401 }
      );
      clearSessionCookies(response);
      return response;
    }
  } else if (isEntraTokenExpiring(entry.entraAccessToken)) {
    // No refresh token available and the access token is expiring/expired.
    await deleteTokens(username, sessionId);
    const response = NextResponse.json(
      { error: 'entra refresh token missing; re-authentication required' },
      { status: 401 }
    );
    clearSessionCookies(response);
    return response;
  }

  // Issue new session tokens
  const newTokens = await issueSessionTokens(username, displayName, sessionId);
  const response = NextResponse.json({ status: 'ok' });
  setSessionCookies(response, newTokens.accessToken, newTokens.refreshToken);

  return response;
}
