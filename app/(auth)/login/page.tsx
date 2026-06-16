'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Key, User, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

type AuthMode = 'password' | 'apikey';

export default function LoginPage() {
  const router = useRouter();
  const { login, loginWithApiKey, loginWithEntra, isLoading } = useAuth();
  const [mode, setMode] = useState<AuthMode>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await login(username, password);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  const handleApiKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await loginWithApiKey(apiKey);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-10">
          <div className="relative w-12 h-12 flex items-center justify-center">
            <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-beam/20 via-nebula/15 to-cell/10 animate-breathe" />
            <svg
              viewBox="0 0 24 24"
              className="w-7 h-7 text-beam relative"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              {/* Orbital rings */}
              <ellipse cx="12" cy="12" rx="10" ry="4" opacity="0.4" />
              <ellipse cx="12" cy="12" rx="4" ry="10" opacity="0.4" />
              {/* Core */}
              <circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.8" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            </svg>
          </div>
          <span className="text-2xl font-semibold text-text-primary tracking-tight">
            SYNAPS Demo
          </span>
        </div>

        {/* Card */}
        <div className="glass-card rounded-2xl p-6">
          <div className="text-center mb-6">
            <h1 className="text-lg font-semibold text-text-primary mb-1">
              Sign in to continue
            </h1>
            <p className="text-sm text-text-secondary">
              Access the pipeline monitoring dashboard
            </p>
          </div>

          {/* Microsoft SSO */}
          <Button
            type="button"
            onClick={() => loginWithEntra()}
            disabled={isLoading}
            className="w-full h-10 bg-[#2f2f2f] text-white hover:bg-[#1a1a1a] font-medium rounded-lg gap-2.5 mb-4"
          >
            <svg className="w-4 h-4" viewBox="0 0 21 21" fill="none">
              <rect x="1" y="1" width="9" height="9" fill="#F25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
              <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
              <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
            </svg>
            Sign in with Microsoft
          </Button>

          {/* Divider */}
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 h-px bg-border-subtle" />
            <span className="text-[11px] text-text-tertiary uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-border-subtle" />
          </div>

          {/* Mode Toggle */}
          <div className="flex p-1 mb-6 rounded-lg bg-surface-ground border border-border-subtle">
            <button
              type="button"
              onClick={() => setMode('password')}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-all',
                mode === 'password'
                  ? 'bg-surface-raised text-text-primary shadow-sm'
                  : 'text-text-tertiary hover:text-text-secondary'
              )}
            >
              <User className="w-4 h-4" />
              Password
            </button>
            <button
              type="button"
              onClick={() => setMode('apikey')}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-all',
                mode === 'apikey'
                  ? 'bg-surface-raised text-text-primary shadow-sm'
                  : 'text-text-tertiary hover:text-text-secondary'
              )}
            >
              <Key className="w-4 h-4" />
              API Key
            </button>
          </div>

          {mode === 'password' ? (
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="data-label">Username</label>
                <Input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter username"
                  className="bg-surface-ground border-border-subtle focus:border-beam h-10"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="data-label">Password</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  className="bg-surface-ground border-border-subtle focus:border-beam h-10"
                  required
                />
              </div>

              {error && (
                <div className="text-sm text-error bg-error/10 px-3 py-2 rounded-lg border border-error/20">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-10 bg-beam text-surface-ground hover:bg-beam/90 font-medium rounded-lg gap-2 beam-caustic"
              >
                {isLoading ? (
                  <span className="animate-pulse-soft">Signing in...</span>
                ) : (
                  <>
                    Sign In
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleApiKeySubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="data-label">API Key</label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter your Tiled API key"
                  className="bg-surface-ground border-border-subtle focus:border-cell font-mono text-sm h-10"
                  required
                />
                <p className="text-[11px] text-text-tertiary mt-2">
                  Generate a key with{' '}
                  <code className="text-cell bg-cell/10 px-1.5 py-0.5 rounded">
                    tiled profile api-key create
                  </code>
                </p>
              </div>

              {error && (
                <div className="text-sm text-error bg-error/10 px-3 py-2 rounded-lg border border-error/20">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-10 bg-cell text-surface-ground hover:bg-cell/90 font-medium rounded-lg gap-2"
              >
                {isLoading ? (
                  <span className="animate-pulse-soft">Signing in...</span>
                ) : (
                  <>
                    Sign In with API Key
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </Button>
            </form>
          )}
        </div>

        {/* Footer hint */}
        <p className="text-center text-[11px] text-text-tertiary mt-6">
          Cosmic Observatory • NSLS-II Beamline Monitoring
        </p>
      </div>
    </div>
  );
}
