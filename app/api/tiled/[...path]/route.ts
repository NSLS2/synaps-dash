import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/auth/config';
import { decodeSessionToken } from '@/lib/auth/jwt';
import { getOboTokenForUser } from '@/lib/auth/obo';

const TILED_URL = process.env.NEXT_PUBLIC_TILED_URL || 'https://tiled.nsls2.bnl.gov';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await params;
    const tiledPath = path.join('/');
    const searchParams = request.nextUrl.searchParams.toString();
    const url = `${TILED_URL}/api/v1/${tiledPath}${searchParams ? `?${searchParams}` : ''}`;

    // Determine auth: cookie-session (Entra/OBO) or pass-through (Tiled token/API key)
    let authHeader: string | null = null;

    const sessionCookie = request.cookies.get(ACCESS_COOKIE)?.value;
    if (sessionCookie) {
      try {
        const payload = await decodeSessionToken(sessionCookie, 'access');
        const tiledToken = await getOboTokenForUser(payload.sub);
        authHeader = `Bearer ${tiledToken}`;
      } catch {
        // Cookie invalid/expired - fall through to header-based auth
        authHeader = request.headers.get('Authorization');
      }
    } else {
      authHeader = request.headers.get('Authorization');
    }

    const ifNoneMatch = request.headers.get('If-None-Match');

    const headers: HeadersInit = {};
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }
    if (ifNoneMatch) {
      headers['If-None-Match'] = ifNoneMatch;
    }

    console.log('[Tiled Proxy] Fetching:', url);
    const response = await fetch(url, { headers });

    // Get the content type to handle different response types
    const contentType = response.headers.get('Content-Type') || '';
    const etag = response.headers.get('ETag');

    // Pass 304 Not Modified through unmodified — used by ETag-based change detection.
    if (response.status === 304) {
      const respHeaders: Record<string, string> = {};
      if (etag) respHeaders['ETag'] = etag;
      return new NextResponse(null, { status: 304, headers: respHeaders });
    }

    if (!response.ok) {
      const error = await response.text();
      console.error('[Tiled Proxy] Error from tiled:', response.status, url, error.slice(0, 500));
      return NextResponse.json(
        { error: error || `Request failed: ${response.status}` },
        { status: response.status }
      );
    }

    // Handle JSON responses
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return NextResponse.json(data);
    }

    // Handle SVG
    if (contentType.includes('svg')) {
      const text = await response.text();
      return new NextResponse(text, {
        headers: {
          'Content-Type': contentType,
        },
      });
    }

    // Default: pass through as binary. Covers images, application/octet-stream,
    // application/x-numpy, etc. Text-encoded responses are handled above; anything
    // else is opaque bytes that must not be re-encoded as a string.
    const buffer = await response.arrayBuffer();
    const respHeaders: Record<string, string> = {
      'Content-Type': contentType,
      // no-cache + must-revalidate forces conditional revalidation on every request
      // so the client sees fresh data while still benefiting from 304s.
      'Cache-Control': 'no-cache, must-revalidate',
    };
    if (etag) respHeaders['ETag'] = etag;
    return new NextResponse(buffer, { headers: respHeaders });
  } catch (error) {
    console.error('[Tiled Proxy] Error:', error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Request failed' },
      { status: 500 }
    );
  }
}
