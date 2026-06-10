import { NextRequest, NextResponse } from 'next/server';
import { SignJWT, jwtVerify } from 'jose';
import { SESSION_SECRET } from './config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const OIDC_FLOW_COOKIE = 'oidc_flow';
export const OIDC_FLOW_LIFETIME_SECONDS = 10 * 60; // 10 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface OidcFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(SESSION_SECRET);
}

function generateRandomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(data: Uint8Array): string {
  const base64 = Buffer.from(data).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create cryptographically random state material for authorization-code flow.
 */
export function createOidcFlowState(): OidcFlowState {
  return {
    state: generateRandomString(32),
    nonce: generateRandomString(32),
    codeVerifier: generateRandomString(48),
    createdAt: Date.now(),
  };
}

/**
 * Build S256 PKCE code_challenge from code_verifier.
 */
export async function buildPkceChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Serialize flow state into a signed JWT (HS256 with SESSION_SECRET) and
 * set it as an httpOnly cookie on the response.
 *
 * JWT payload: { state, nonce, code_verifier, type: 'oidc_flow', exp }
 */
export async function setOidcFlowCookie(
  response: NextResponse,
  flowState: OidcFlowState
): Promise<void> {
  const secret = getSecretKey();
  const token = await new SignJWT({
    state: flowState.state,
    nonce: flowState.nonce,
    code_verifier: flowState.codeVerifier,
    type: 'oidc_flow',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + OIDC_FLOW_LIFETIME_SECONDS)
    .setIssuedAt()
    .sign(secret);

  const isLocalhost = process.env.NODE_ENV === 'development';

  response.cookies.set(OIDC_FLOW_COOKIE, token, {
    httpOnly: true,
    secure: !isLocalhost,
    sameSite: 'lax', // Must be lax for cross-site top-level redirect from Entra
    path: '/',
    maxAge: OIDC_FLOW_LIFETIME_SECONDS,
  });
}

/**
 * Read the oidc_flow cookie from the request, verify the JWT signature,
 * validate that `state` matches the query param, and return the nonce +
 * codeVerifier.
 *
 * Always marks the cookie for deletion (single-use).
 *
 * Throws if:
 * - Cookie missing or JWT invalid/expired
 * - JWT `type` claim is not `oidc_flow`
 * - state param does not match the JWT's state claim
 */
export async function validateAndConsumeOidcFlow(
  request: NextRequest,
  stateParam: string
): Promise<{ nonce: string; codeVerifier: string }> {
  const cookieValue = request.cookies.get(OIDC_FLOW_COOKIE)?.value;
  if (!cookieValue) {
    throw new Error('OIDC flow cookie missing');
  }

  const secret = getSecretKey();
  const { payload } = await jwtVerify(cookieValue, secret, {
    algorithms: ['HS256'],
  });

  if (payload.type !== 'oidc_flow') {
    throw new Error('Invalid OIDC flow token type');
  }

  if (payload.state !== stateParam) {
    throw new Error('OIDC state mismatch');
  }

  return {
    nonce: payload.nonce as string,
    codeVerifier: payload.code_verifier as string,
  };
}

/**
 * Delete the oidc_flow cookie on a response (call after validation).
 */
export function clearOidcFlowCookie(response: NextResponse): void {
  response.cookies.set(OIDC_FLOW_COOKIE, '', { path: '/', maxAge: 0 });
}
