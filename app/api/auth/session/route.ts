import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest, setSessionCookies, clearSessionCookies } from '@/lib/auth/cookies';
import { issueSessionTokens } from '@/lib/auth/jwt';
import { deleteTokens, getTokens } from '@/lib/auth/token-store';
import { isEntraTokenExpiring } from '@/lib/auth/entra';

export async function GET(request: NextRequest) {
  const session = await getSessionFromRequest(request);

  if (!session) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  if (!session.sessionId) {
    const response = NextResponse.json({ error: 'not authenticated' }, { status: 401 });
    clearSessionCookies(response);
    return response;
  }

  // Ensure server-side Entra credentials still exist
  const entry = await getTokens(session.username, session.sessionId);
  if (!entry) {
    const response = NextResponse.json({ error: 'not authenticated' }, { status: 401 });
    clearSessionCookies(response);
    return response;
  }

  // If Entra access is expiring and cannot be refreshed, force re-authentication
  if (!entry.entraRefreshToken && isEntraTokenExpiring(entry.entraAccessToken)) {
    await deleteTokens(session.username, session.sessionId);
    const response = NextResponse.json({ error: 'not authenticated' }, { status: 401 });
    clearSessionCookies(response);
    return response;
  }

  // If the access token was valid, return user info directly
  if (session.source === 'access') {
    return NextResponse.json({
      username: session.username,
      display_name: session.displayName,
      source: 'entra',
    });
  }

  // Access expired but refresh is valid -- reissue session tokens
  const newTokens = await issueSessionTokens(
    session.username,
    session.displayName,
    session.sessionId
  );
  const response = NextResponse.json({
    username: session.username,
    display_name: session.displayName,
    source: 'entra',
  });
  setSessionCookies(response, newTokens.accessToken, newTokens.refreshToken);

  return response;
}
