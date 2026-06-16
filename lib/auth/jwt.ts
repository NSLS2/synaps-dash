import 'server-only';
import { SignJWT, jwtVerify } from 'jose';
import {
  SESSION_SECRET,
  ACCESS_TOKEN_LIFETIME,
  REFRESH_TOKEN_LIFETIME,
} from './config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionPayload {
  sub: string; // username (Entra OID)
  name: string; // display name
  type: 'access' | 'refresh';
  sid?: string; // logical session id (required for new tokens)
  exp: number;
}

interface SessionTokenClaims {
  sub: string;
  name: string;
  type: SessionPayload['type'];
  sid: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(SESSION_SECRET);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a session JWT signed with SESSION_SECRET (HS256).
 * Mirrors: FastAPI app/utils/auth.py create_token()
 */
export async function createSessionToken(
  payload: SessionTokenClaims,
  lifetime: number
): Promise<string> {
  const secret = getSecretKey();
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + lifetime)
    .setIssuedAt()
    .sign(secret);
}

/**
 * Decode and verify a session JWT.
 * Mirrors: FastAPI app/utils/auth.py decode_token()
 *
 * Throws if signature invalid, token expired, or type mismatch.
 */
export async function decodeSessionToken(
  token: string,
  expectedType: SessionPayload['type']
): Promise<SessionPayload> {
  const secret = getSecretKey();
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ['HS256'],
  });

  if (payload.type !== expectedType) {
    throw new Error(`Expected token type '${expectedType}', got '${payload.type}'`);
  }

  return payload as unknown as SessionPayload;
}

/**
 * Generate a session id shared across access/refresh tokens.
 */
export function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Issue a pair of session tokens (access + refresh).
 * Mirrors: FastAPI app/utils/auth.py issue_session_tokens()
 */
export async function issueSessionTokens(
  username: string,
  displayName: string,
  sessionId: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = await createSessionToken(
    { sub: username, name: displayName, type: 'access', sid: sessionId },
    ACCESS_TOKEN_LIFETIME
  );
  const refreshToken = await createSessionToken(
    { sub: username, name: displayName, type: 'refresh', sid: sessionId },
    REFRESH_TOKEN_LIFETIME
  );
  return { accessToken, refreshToken };
}
