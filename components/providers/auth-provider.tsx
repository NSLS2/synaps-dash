'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { TiledUser, AppSessionUser } from '@/lib/tiled/types';
import {
  getStoredTokens,
  getStoredApiKey,
  getAuthType,
  loginWithPassword,
  validateApiKey,
  logout as tiledLogout,
  getCurrentUser,
  refreshAccessToken,
  isTokenExpired,
  isRefreshTokenExpired,
  getTokenStatus,
  setEntraAuthMarker,
  clearEntraAuthMarker,
} from '@/lib/tiled/auth';
import { onAuthError } from '@/lib/tiled/client';

interface AuthState {
  user: AppSessionUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  accessToken: string | null;
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  loginWithApiKey: (apiKey: string) => Promise<void>;
  loginWithEntra: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toAppSessionUser(
  tiledUser: TiledUser | null,
  fallbackName: string = 'user'
): AppSessionUser | null {
  if (!tiledUser) {
    return null;
  }

  const identity = tiledUser.identities?.[0]?.id || fallbackName;
  return {
    username: identity,
    displayName: identity,
    source: 'tiled',
    tiledUser,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    accessToken: null,
  });

  const checkAuth = useCallback(async () => {
    // 1. FIRST: Check for Entra cookie session via /api/auth/session
    try {
      const sessionResponse = await fetch('/api/auth/session');
      if (sessionResponse.ok) {
        const sessionData = await sessionResponse.json();
        setEntraAuthMarker();
        setState({
          user: {
            username: sessionData.username,
            displayName: sessionData.display_name,
            source: 'entra',
          },
          isAuthenticated: true,
          isLoading: false,
          accessToken: null, // Server-side cookies handle auth
        });
        return;
      }
      // Non-200: clear stale Entra marker
      clearEntraAuthMarker();
    } catch {
      // Network error: keep marker unchanged, continue to fallback
    }

    // 2. Check API key auth
    const authType = getAuthType();
    if (authType === 'apikey') {
      const apiKey = getStoredApiKey();
      if (apiKey) {
        const user = await getCurrentUser(apiKey);
        setState({
          user: toAppSessionUser(user),
          isAuthenticated: !!user,
          isLoading: false,
          accessToken: apiKey,
        });
        return;
      }
    }

    // 3. Token-based auth
    const { accessToken } = getStoredTokens();

    if (!accessToken) {
      setState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        accessToken: null,
      });
      return;
    }

    // Refresh if expired
    if (isTokenExpired()) {
      const refreshed = await refreshAccessToken();
      if (!refreshed) {
        setState({
          user: null,
          isAuthenticated: false,
          isLoading: false,
          accessToken: null,
        });
        return;
      }
    }

    const { accessToken: currentToken } = getStoredTokens();
    if (!currentToken) {
      setState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        accessToken: null,
      });
      return;
    }

    const tiledUser = await getCurrentUser(currentToken);

    setState({
      user: toAppSessionUser(tiledUser),
      isAuthenticated: !!tiledUser,
      isLoading: false,
      accessToken: currentToken,
    });
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Listen for auth errors from API calls (401 responses)
  useEffect(() => {
    const unsubscribe = onAuthError(() => {
      console.log('[Auth] Auth error received, logging out');
      setState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        accessToken: null,
      });
    });
    return unsubscribe;
  }, []);

  // Refresh token proactively and when tab becomes visible
  useEffect(() => {
    if (!state.isAuthenticated) return;

    const authType = getAuthType();

    // API keys don't expire
    if (authType === 'apikey') return;

    if (authType === 'entra') {
      // Entra sessions: periodically refresh via server-side endpoint
      const refreshEntra = async () => {
        try {
          const response = await fetch('/api/auth/entra/refresh', { method: 'POST' });
          if (!response.ok) {
            console.log('[Auth] Entra refresh failed, re-checking session...');
            checkAuth();
          }
        } catch {
          // Network error, skip
        }
      };

      const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
          refreshEntra();
        }
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);
      // Refresh every 8 minutes (access token is 10min)
      const interval = setInterval(refreshEntra, 8 * 60 * 1000);
      // Also refresh immediately on mount
      refreshEntra();

      return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        clearInterval(interval);
      };
    }

    // Tiled token-based refresh logic (existing)
    const refresh = async (force = false) => {
      const status = getTokenStatus();
      console.log('[Auth] Token status:', {
        accessExpiresIn: `${status.accessExpiresIn}s (${Math.round(status.accessExpiresIn / 60)}min)`,
        refreshExpiresIn: `${status.refreshExpiresIn}s (${Math.round(status.refreshExpiresIn / 60)}min)`,
        accessExpired: status.accessExpired,
        refreshExpired: status.refreshExpired,
      });

      if (status.refreshExpired) {
        console.log('[Auth] Refresh token expired, cannot refresh');
        return;
      }

      if (force || status.accessExpired) {
        console.log('[Auth] Refreshing token...', { force });
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          console.log('[Auth] Token refreshed successfully');
          checkAuth();
        } else {
          console.log('[Auth] Token refresh failed');
        }
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh(true);
      }
    };

    const handleFocus = () => {
      refresh();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    const interval = setInterval(() => refresh(), 2 * 60 * 1000);
    refresh();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      clearInterval(interval);
    };
  }, [state.isAuthenticated, checkAuth]);

  const login = async (username: string, password: string) => {
    setState((prev) => ({ ...prev, isLoading: true }));

    try {
      const tokens = await loginWithPassword(username, password);
      const tiledUser = await getCurrentUser(tokens.access_token);

      setState({
        user: toAppSessionUser(tiledUser, username),
        isAuthenticated: true,
        isLoading: false,
        accessToken: tokens.access_token,
      });
    } catch (error) {
      setState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        accessToken: null,
      });
      throw error;
    }
  };

  const loginWithApiKeyFn = async (apiKey: string) => {
    setState((prev) => ({ ...prev, isLoading: true }));

    try {
      const tiledUser = await validateApiKey(apiKey);

      setState({
        user: toAppSessionUser(tiledUser),
        isAuthenticated: true,
        isLoading: false,
        accessToken: apiKey,
      });
    } catch (error) {
      setState({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        accessToken: null,
      });
      throw error;
    }
  };

  const loginWithEntra = () => {
    window.location.href = '/api/auth/entra/login';
  };

  const logout = async () => {
    const authType = getAuthType();

    if (authType === 'entra') {
      // Clear server-side session
      try {
        await fetch('/api/auth/entra/logout', { method: 'POST' });
      } catch {
        // Best effort
      }
      clearEntraAuthMarker();
    } else {
      await tiledLogout();
    }

    setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      accessToken: null,
    });
  };

  return (
    <AuthContext.Provider value={{ ...state, login, loginWithApiKey: loginWithApiKeyFn, loginWithEntra, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
