import { TokenResponse, TiledUser } from './types';

const TOKEN_KEY = 'tiled_access_token';
const REFRESH_TOKEN_KEY = 'tiled_refresh_token';
const TOKEN_EXPIRY_KEY = 'tiled_token_expiry';
const REFRESH_TOKEN_EXPIRY_KEY = 'tiled_refresh_token_expiry';
const API_KEY_KEY = 'tiled_api_key';
const AUTH_TYPE_KEY = 'tiled_auth_type';

type AuthType = 'token' | 'apikey' | 'entra';

export function getStoredTokens(): { accessToken: string | null; refreshToken: string | null; expiresAt: number | null } {
  if (typeof window === 'undefined') {
    return { accessToken: null, refreshToken: null, expiresAt: null };
  }

  return {
    accessToken: localStorage.getItem(TOKEN_KEY),
    refreshToken: localStorage.getItem(REFRESH_TOKEN_KEY),
    expiresAt: localStorage.getItem(TOKEN_EXPIRY_KEY) ? parseInt(localStorage.getItem(TOKEN_EXPIRY_KEY)!) : null,
  };
}

export function getStoredApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(API_KEY_KEY);
}

export function getAuthType(): AuthType | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(AUTH_TYPE_KEY) as AuthType | null;
}

export function setEntraAuthMarker(): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(AUTH_TYPE_KEY, 'entra');
  // Clear any Tiled tokens when switching to Entra
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
  localStorage.removeItem(REFRESH_TOKEN_EXPIRY_KEY);
  localStorage.removeItem(API_KEY_KEY);
}

export function clearEntraAuthMarker(): void {
  if (typeof window === 'undefined') return;
  if (localStorage.getItem(AUTH_TYPE_KEY) === 'entra') {
    localStorage.removeItem(AUTH_TYPE_KEY);
  }
}

export function storeTokens(response: TokenResponse): void {
  if (typeof window === 'undefined') return;

  const expiresAt = Date.now() + response.expires_in * 1000;
  localStorage.setItem(TOKEN_KEY, response.access_token);
  localStorage.setItem(REFRESH_TOKEN_KEY, response.refresh_token);
  localStorage.setItem(TOKEN_EXPIRY_KEY, expiresAt.toString());
  localStorage.setItem(AUTH_TYPE_KEY, 'token');
  localStorage.removeItem(API_KEY_KEY);

  // Store refresh token expiry if provided
  if (response.refresh_token_expires_in) {
    const refreshExpiresAt = Date.now() + response.refresh_token_expires_in * 1000;
    localStorage.setItem(REFRESH_TOKEN_EXPIRY_KEY, refreshExpiresAt.toString());
    console.log('[Auth] Token lifetimes:', {
      access_token_expires_in: `${response.expires_in}s (${Math.round(response.expires_in / 60)}min)`,
      refresh_token_expires_in: `${response.refresh_token_expires_in}s (${Math.round(response.refresh_token_expires_in / 60)}min)`,
    });
  }
}

export function storeApiKey(apiKey: string): void {
  if (typeof window === 'undefined') return;

  localStorage.setItem(API_KEY_KEY, apiKey);
  localStorage.setItem(AUTH_TYPE_KEY, 'apikey');
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
}

export function clearTokens(): void {
  if (typeof window === 'undefined') return;

  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
  localStorage.removeItem(REFRESH_TOKEN_EXPIRY_KEY);
  localStorage.removeItem(API_KEY_KEY);
  localStorage.removeItem(AUTH_TYPE_KEY);
}

export function isTokenExpired(): boolean {
  const { expiresAt } = getStoredTokens();
  if (!expiresAt) {
    console.log('[Auth] isTokenExpired: No expiry stored, considering expired');
    return true;
  }
  const now = Date.now();
  const buffer = 5 * 60 * 1000; // 5 minutes buffer
  const expired = now > expiresAt - buffer;
  const timeLeft = Math.round((expiresAt - now) / 1000);

  if (expired) {
    console.log(`[Auth] isTokenExpired: YES (${timeLeft}s until actual expiry)`);
  }

  return expired;
}

export function isRefreshTokenExpired(): boolean {
  if (typeof window === 'undefined') return true;
  const refreshExpiresAt = localStorage.getItem(REFRESH_TOKEN_EXPIRY_KEY);
  if (!refreshExpiresAt) return false; // If we don't know, assume it's valid
  // Consider expired 1 minute before actual expiry
  return Date.now() > parseInt(refreshExpiresAt) - 60 * 1000;
}

export function getTokenStatus(): { accessExpired: boolean; refreshExpired: boolean; accessExpiresIn: number; refreshExpiresIn: number } {
  const { expiresAt } = getStoredTokens();
  const refreshExpiresAt = localStorage.getItem(REFRESH_TOKEN_EXPIRY_KEY);

  const now = Date.now();
  const accessExpiresIn = expiresAt ? Math.round((expiresAt - now) / 1000) : 0;
  const refreshExpiresIn = refreshExpiresAt ? Math.round((parseInt(refreshExpiresAt) - now) / 1000) : 0;

  return {
    accessExpired: isTokenExpired(),
    refreshExpired: isRefreshTokenExpired(),
    accessExpiresIn,
    refreshExpiresIn,
  };
}

export async function loginWithPassword(username: string, password: string): Promise<TokenResponse> {
  // Use local API route to avoid CORS issues
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Login failed');
  }

  storeTokens(data);
  return data;
}

export async function validateApiKey(apiKey: string): Promise<TiledUser> {
  // Validate API key by calling whoami
  const response = await fetch('/api/auth/whoami', {
    headers: {
      'Authorization': `Apikey ${apiKey}`,
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Invalid API key');
  }

  const user = await response.json();
  storeApiKey(apiKey);
  return user;
}

// Prevent concurrent refresh attempts
let refreshPromise: Promise<TokenResponse | null> | null = null;

export async function refreshAccessToken(): Promise<TokenResponse | null> {
  // If a refresh is already in progress, wait for it
  if (refreshPromise) {
    return refreshPromise;
  }

  const { refreshToken } = getStoredTokens();
  if (!refreshToken) return null;

  refreshPromise = (async () => {
    try {
      console.log('[Auth] Calling refresh endpoint...');
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (response.ok) {
        const data: TokenResponse = await response.json();
        console.log('[Auth] Refresh response:', {
          has_access_token: !!data.access_token,
          has_refresh_token: !!data.refresh_token,
          expires_in: data.expires_in,
          token_type: data.token_type,
        });

        // Some servers don't return a new refresh_token - keep the old one
        if (!data.refresh_token) {
          const { refreshToken: oldRefreshToken } = getStoredTokens();
          if (oldRefreshToken) {
            data.refresh_token = oldRefreshToken;
            console.log('[Auth] Keeping existing refresh token');
          }
        }

        storeTokens(data);
        return data;
      }

      // Log the error response
      const errorText = await response.text().catch(() => 'Could not read error');
      console.log('[Auth] Refresh failed:', {
        status: response.status,
        error: errorText,
      });

      // Clear tokens on auth errors (401/403/422 = invalid/expired refresh token)
      if (response.status === 401 || response.status === 403 || response.status === 422) {
        console.log('[Auth] Clearing tokens due to auth error');
        clearTokens();
        return null;
      }

      // Other errors - don't clear tokens, might be temporary
      return null;
    } catch (err) {
      // Network error - don't clear tokens
      console.log('[Auth] Refresh network error:', err);
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function getCurrentUser(accessTokenOrApiKey: string): Promise<TiledUser | null> {
  try {
    const authType = getAuthType();
    const authHeader = authType === 'apikey'
      ? `Apikey ${accessTokenOrApiKey}`
      : `Bearer ${accessTokenOrApiKey}`;

    // Use local API route to avoid CORS issues
    const response = await fetch('/api/auth/whoami', {
      headers: {
        'Authorization': authHeader,
      },
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  // Just clear tokens locally - no need to call server
  clearTokens();
}

export async function getValidAccessToken(): Promise<string | null> {
  const authType = getAuthType();

  // For Entra sessions, auth is handled server-side via cookies
  if (authType === 'entra') {
    return null;
  }

  // If using API key, return it directly (they don't expire)
  if (authType === 'apikey') {
    return getStoredApiKey();
  }

  // Token-based auth
  const { accessToken } = getStoredTokens();

  if (!accessToken) {
    console.log('[Auth] getValidAccessToken: No access token stored');
    return null;
  }

  if (isTokenExpired()) {
    console.log('[Auth] getValidAccessToken: Token expired, refreshing...');
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      console.log('[Auth] getValidAccessToken: Refresh failed');
      return null;
    }
    console.log('[Auth] getValidAccessToken: Refresh succeeded');
    return refreshed.access_token;
  }

  return accessToken;
}

export function getAuthHeader(): string | null {
  const authType = getAuthType();

  if (authType === 'apikey') {
    const apiKey = getStoredApiKey();
    return apiKey ? `Apikey ${apiKey}` : null;
  }

  const { accessToken } = getStoredTokens();
  return accessToken ? `Bearer ${accessToken}` : null;
}
