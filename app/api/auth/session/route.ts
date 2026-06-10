import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest, setSessionCookies } from '@/lib/auth/cookies';
import { issueSessionTokens } from '@/lib/auth/jwt';

export async function GET(request: NextRequest) {
  const session = await getSessionFromRequest(request);

  if (!session) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
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
  const newTokens = await issueSessionTokens(session.username, session.displayName);
  const response = NextResponse.json({
    username: session.username,
    display_name: session.displayName,
    source: 'entra',
  });
  setSessionCookies(response, newTokens.accessToken, newTokens.refreshToken);

  return response;
}
