import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/auth/config';
import { decodeSessionToken } from '@/lib/auth/jwt';
import { clearSessionCookies } from '@/lib/auth/cookies';
import { deleteTokens } from '@/lib/auth/token-store';
import { clearOboCache } from '@/lib/auth/obo';

export async function POST(request: NextRequest) {
  let username: string | null = null;

  // Try to get username from access cookie first, then refresh cookie
  const accessCookie = request.cookies.get(ACCESS_COOKIE)?.value;
  if (accessCookie) {
    try {
      const payload = await decodeSessionToken(accessCookie, 'access');
      username = payload.sub;
    } catch {
      // Ignore -- try refresh cookie
    }
  }

  if (!username) {
    const refreshCookie = request.cookies.get(REFRESH_COOKIE)?.value;
    if (refreshCookie) {
      try {
        const payload = await decodeSessionToken(refreshCookie, 'refresh');
        username = payload.sub;
      } catch {
        // Ignore
      }
    }
  }

  // Clean up server-side state
  if (username) {
    deleteTokens(username);
    clearOboCache(username);
  }

  // Clear cookies
  const response = NextResponse.json({ status: 'ok' });
  clearSessionCookies(response);

  return response;
}
