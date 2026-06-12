import { WebSocket as NodeWebSocket } from 'ws';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/auth/config';
import { decodeSessionToken } from '@/lib/auth/jwt';
import { getOboTokenForUser } from '@/lib/auth/obo';

const TILED_URL = process.env.NEXT_PUBLIC_TILED_URL || 'https://tiled.nsls2.bnl.gov';

// Mark this route as using WebSocket handler
export const dynamic = 'force-dynamic';

// Standard HTTP handler - WebSocket routes still need this for Next.js 16
export async function GET() {
  return new Response('WebSocket endpoint - upgrade connection to use', { status: 426 });
}

// Create a short-lived API key for WebSocket authentication
// Following tiled's pattern: create key, connect, then revoke immediately
async function createApiKey(accessToken: string): Promise<{ secret: string; firstEight: string } | null> {
  try {
    const response = await fetch(`${TILED_URL}/api/v1/auth/apikey`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expires_in: 60, // 1 minute - only needs to last for handshake
        scopes: ['read:data', 'read:metadata'],
        note: 'websocket-proxy',
      }),
    });

    if (!response.ok) {
      console.error('[WS Proxy] Failed to create API key:', response.status, await response.text());
      return null;
    }

    const data = await response.json();
    console.log('[WS Proxy] Created API key:', data.first_eight);
    return { secret: data.secret, firstEight: data.first_eight };
  } catch (error) {
    console.error('[WS Proxy] Error creating API key:', error);
    return null;
  }
}

// Revoke an API key after websocket connection is established
async function revokeApiKey(accessToken: string, firstEight: string): Promise<void> {
  try {
    const response = await fetch(`${TILED_URL}/api/v1/auth/apikey?first_eight=${firstEight}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    if (response.ok) {
      console.log('[WS Proxy] Revoked API key:', firstEight);
    } else {
      console.warn('[WS Proxy] Failed to revoke API key:', response.status);
    }
  } catch (error) {
    console.warn('[WS Proxy] Error revoking API key:', error);
  }
}

export function SOCKET(
  client: import('ws').WebSocket,
  request: import('http').IncomingMessage,
  server: import('ws').WebSocketServer
) {
  const url = new URL(request.url || '', `http://${request.headers.host}`);

  // Extract path from URL (remove /api/ws prefix)
  const pathMatch = url.pathname.match(/^\/api\/ws\/(.+)$/);
  const tiledPath = pathMatch ? pathMatch[1] : '';

  // Get auth token from query params
  const token = url.searchParams.get('token');
  const authType = url.searchParams.get('auth_type') || 'token';

  // Try cookie-based auth (Entra/OBO) first
  let effectiveToken: string | null = token;
  let effectiveAuthType: string = authType;
  let cookieAuthPromise: Promise<string | null> | null = null;

  const cookieHeader = request.headers.cookie || '';
  const accessCookieMatch = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${ACCESS_COOKIE}=([^;]+)`)
  );
  const refreshCookieMatch = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${REFRESH_COOKIE}=([^;]+)`)
  );

  if (accessCookieMatch || refreshCookieMatch) {
    cookieAuthPromise = (async () => {
      try {
        if (accessCookieMatch) {
          const accessCookieValue = decodeURIComponent(accessCookieMatch[1]);
          const accessPayload = await decodeSessionToken(accessCookieValue, 'access');
          return await getOboTokenForUser(accessPayload.sub);
        }
      } catch {
        // Access cookie invalid/expired -- try refresh cookie below
      }

      try {
        if (refreshCookieMatch) {
          const refreshCookieValue = decodeURIComponent(refreshCookieMatch[1]);
          const refreshPayload = await decodeSessionToken(refreshCookieValue, 'refresh');
          return await getOboTokenForUser(refreshPayload.sub);
        }
      } catch {
        return null;
      }

      return null;
    })();
  }

  // Build Tiled WebSocket URL with required params
  const wsUrl = TILED_URL.replace('https://', 'wss://').replace('http://', 'ws://');
  const tiledParams = new URLSearchParams();
  tiledParams.set('envelope_format', 'json');

  const start = url.searchParams.get('start');
  if (start) {
    tiledParams.set('start', start);
  }

  const tiledWsUrl = `${wsUrl}/api/v1/stream/single/${tiledPath}?${tiledParams.toString()}`;

  console.log('[WS Proxy] Client connected, proxying to:', tiledWsUrl);
  console.log('[WS Proxy] Auth type:', effectiveAuthType, 'Token present:', !!effectiveToken, 'Cookie auth:', !!cookieAuthPromise);

  // Connect to Tiled - need to handle async API key creation
  const connectToTiled = async () => {
    // Resolve effective token from cookie auth if applicable
    if (cookieAuthPromise) {
      const oboToken = await cookieAuthPromise;
      if (oboToken) {
        effectiveToken = oboToken;
        effectiveAuthType = 'token';
      }
    }

    let apiKey: string | null = null;
    let keyInfo: { secret: string; firstEight: string } | null = null;

    if (effectiveToken) {
      if (effectiveAuthType === 'apikey') {
        // Already have an API key, use it directly
        apiKey = effectiveToken;
        console.log('[WS Proxy] Using provided API key');
      } else {
        // Have a Bearer token, create a short-lived API key
        console.log('[WS Proxy] Creating API key from access token...');
        keyInfo = await createApiKey(effectiveToken);
        if (!keyInfo) {
          client.send(JSON.stringify({ type: 'proxy-error', error: 'Failed to create API key' }));
          client.close(1011, 'Auth error');
          return;
        }
        apiKey = keyInfo.secret;
      }
    }

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Apikey ${apiKey}`;
    }

    const tiledWs = new NodeWebSocket(tiledWsUrl, { headers });

    // Track if we've revoked the key to avoid double-revoke
    let keyRevoked = false;
    const revokeKeyOnce = () => {
      if (!keyRevoked && keyInfo && effectiveToken) {
        keyRevoked = true;
        revokeApiKey(effectiveToken, keyInfo.firstEight);
      }
    };

    tiledWs.on('open', () => {
      console.log('[WS Proxy] Connected to Tiled');
      client.send(JSON.stringify({ type: 'proxy-connected' }));
      // Revoke key after successful handshake
      revokeKeyOnce();
    });

    tiledWs.on('message', (data) => {
      if (client.readyState === client.OPEN) {
        client.send(data.toString());
      }
    });

    tiledWs.on('close', (code, reason) => {
      console.log('[WS Proxy] Tiled connection closed:', code, reason.toString());
      if (client.readyState === client.OPEN) {
        client.close(code, reason.toString());
      }
    });

    tiledWs.on('error', (error: Error & { code?: string }) => {
      console.error('[WS Proxy] Tiled connection error:', error.message);
      // Revoke key on error to prevent leaks
      revokeKeyOnce();
      // Log additional details for debugging
      if (error.message.includes('500')) {
        console.error('[WS Proxy] Server returned 500 - WebSocket streaming may not be enabled for this catalog');
      }
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({
          type: 'proxy-error',
          error: error.message,
          code: error.code,
          recoverable: false
        }));
        client.close(1011, 'Upstream error');
      }
    });

    client.on('message', (data) => {
      if (tiledWs.readyState === tiledWs.OPEN) {
        tiledWs.send(data.toString());
      }
    });

    client.on('close', () => {
      console.log('[WS Proxy] Client disconnected');
      if (tiledWs.readyState === tiledWs.OPEN) {
        tiledWs.close();
      }
    });

    client.on('error', (error) => {
      console.error('[WS Proxy] Client error:', error.message);
      if (tiledWs.readyState === tiledWs.OPEN) {
        tiledWs.close();
      }
    });
  };

  connectToTiled();
}
