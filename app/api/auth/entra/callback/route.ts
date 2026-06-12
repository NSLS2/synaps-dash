import { NextRequest, NextResponse } from 'next/server';
import { assertAuthConfig, buildCallbackUrl } from '@/lib/auth/config';
import { validateAndConsumeOidcFlow, clearOidcFlowCookie } from '@/lib/auth/oidc-flow';
import { exchangeCodeForUser } from '@/lib/auth/entra';
import { setTokens } from '@/lib/auth/token-store';
import { generateSessionId, issueSessionTokens } from '@/lib/auth/jwt';
import { setSessionCookies } from '@/lib/auth/cookies';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  assertAuthConfig();

  const code = request.nextUrl.searchParams.get('code');
  const stateParam = request.nextUrl.searchParams.get('state');
  const error = request.nextUrl.searchParams.get('error');

  // Handle Entra error response
  if (error) {
    console.error('[Entra Callback] Error from Entra:', error);
    const response = NextResponse.redirect(new URL('/login?error=signin_failed', request.url));
    clearOidcFlowCookie(response);
    return response;
  }

  if (!code || !stateParam) {
    const response = NextResponse.redirect(new URL('/login?error=missing_code', request.url));
    clearOidcFlowCookie(response);
    return response;
  }

  const response = NextResponse.redirect(new URL('/', request.url));

  try {
    // Validate OIDC flow state (checks cookie, state match)
    const { nonce, codeVerifier } = await validateAndConsumeOidcFlow(
      request,
      response,
      stateParam
    );

    // Build the same redirect_uri used in the login request
    const redirectUri = buildCallbackUrl(request);

    // Exchange code for tokens and verify id_token
    const { username, displayName, accessToken, refreshToken } =
      await exchangeCodeForUser(code, redirectUri, codeVerifier, nonce);

    const sessionId = generateSessionId();

    // Store Entra tokens for this app session
    await setTokens(username, sessionId, {
      entraAccessToken: accessToken,
      entraRefreshToken: refreshToken,
      storedAt: Date.now(),
    });

    // Issue app-level session tokens
    const sessionTokens = await issueSessionTokens(username, displayName, sessionId);

    // Redirect to app root with session cookies set
    setSessionCookies(response, sessionTokens.accessToken, sessionTokens.refreshToken);

    return response;
  } catch (err) {
    console.error('[Entra Callback] Auth failed:', err instanceof Error ? err.message : err);
    const errorResponse = NextResponse.redirect(new URL('/login?error=signin_failed', request.url));
    clearOidcFlowCookie(errorResponse);
    return errorResponse;
  }
}
