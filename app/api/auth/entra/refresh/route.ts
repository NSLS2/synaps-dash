import { NextRequest, NextResponse } from 'next/server';
import { REFRESH_COOKIE } from '@/lib/auth/config';
import { decodeSessionToken, issueSessionTokens } from '@/lib/auth/jwt';
import { setSessionCookies, clearSessionCookies } from '@/lib/auth/cookies';
import { getTokens, getFreshEntraToken, setTokens } from '@/lib/auth/token-store';
import { refreshEntraAccessToken } from '@/lib/auth/entra';

export async function POST(request: NextRequest) {
  const refreshCookie = request.cookies.get(REFRESH_COOKIE)?.value;

  if (!refreshCookie) {
    return NextResponse.json({ error: 'missing refresh token' }, { status: 401 });
  }

  let username: string;
  let displayName: string;

  try {
    const payload = await decodeSessionToken(refreshCookie, 'refresh');
    username = payload.sub;
    displayName = payload.name || username;
  } catch {
    const response = NextResponse.json({ error: 'invalid refresh token' }, { status: 401 });
    clearSessionCookies(response);
    return response;
  }

  // Try to refresh the underlying Entra token
  const entry = getTokens(username);
  if (!entry) {
    const response = NextResponse.json({ error: 'missing entra credentials' }, { status: 401 });
    clearSessionCookies(response);
    return response;
  }

  if (entry.entraRefreshToken) {
    try {
      const refreshed = await refreshEntraAccessToken(entry.entraRefreshToken);
      setTokens(username, {
        entraAccessToken: refreshed.accessToken,
        entraRefreshToken: refreshed.refreshToken,
        storedAt: Date.now(),
      });
    } catch (err) {
      console.error('[Entra Refresh] Failed:', err instanceof Error ? err.message : err);
      // Clear stored tokens on refresh failure
      const { deleteTokens } = await import('@/lib/auth/token-store');
      deleteTokens(username);
      const response = NextResponse.json(
        { error: 'entra refresh failed' },
        { status: 401 }
      );
      clearSessionCookies(response);
      return response;
    }
  }

  // Issue new session tokens
  const newTokens = await issueSessionTokens(username, displayName);
  const response = NextResponse.json({ status: 'ok' });
  setSessionCookies(response, newTokens.accessToken, newTokens.refreshToken);

  return response;
}
