import { NextRequest, NextResponse } from 'next/server';
import {
  AUTH_ENDPOINT,
  CLIENT_ID,
  buildCallbackUrl,
  entraUserScope,
  assertAuthConfig,
} from '@/lib/auth/config';
import {
  createOidcFlowState,
  buildPkceChallenge,
  setOidcFlowCookie,
} from '@/lib/auth/oidc-flow';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  assertAuthConfig();

  // Generate OIDC flow state (state, nonce, PKCE code_verifier)
  const flowState = createOidcFlowState();
  const codeChallenge = await buildPkceChallenge(flowState.codeVerifier);
  const redirectUri = buildCallbackUrl(request);

  // Build Entra authorize URL
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: entraUserScope(),
    state: flowState.state,
    nonce: flowState.nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authorizeUrl = `${AUTH_ENDPOINT}?${params.toString()}`;

  // Create redirect response and set OIDC flow cookie
  const response = NextResponse.redirect(authorizeUrl);
  await setOidcFlowCookie(response, flowState);

  return response;
}
