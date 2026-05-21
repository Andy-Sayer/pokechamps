// PokeChamps web viewer home screen. v1 is intentionally one file:
//   - server-URL input + auth form when signed out
//   - matches list when signed in
// Phase 4.2 adds the live battle viewer and we'll split components then.
import { useEffect, useState, type FormEvent } from 'react';
import type { MatchSummary } from '@pokechamps/core/storage/types.js';
import {
  ApiError,
  getBaseUrl,
  getCurrentUser,
  isAuthenticated,
  listMatches,
  login,
  register,
  setBaseUrl,
  signOut,
  type AuthUser,
} from './lib/api.js';
import { BattleView } from './BattleView.js';

type AuthMode = 'login' | 'register';

interface AuthViewProps {
  baseUrl: string;
  onBaseUrlChange: (next: string) => void;
  onAuthed: (user: AuthUser) => void;
}

function AuthView({ baseUrl, onBaseUrlChange, onAuthed }: AuthViewProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(ev: FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setBaseUrl(baseUrl);
      const result = mode === 'login'
        ? await login(email, password)
        : await register(email, password);
      onAuthed(result.user);
    } catch (err) {
      const msg = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'unknown error';
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
      <div className="w-full max-w-md space-y-6">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold">PokeChamps</h1>
          <p className="text-slate-400 text-sm">Web viewer for the Champions doubles assistant.</p>
        </header>
        <form onSubmit={onSubmit} className="space-y-4 bg-slate-900 p-6 rounded-lg shadow">
          <label className="block space-y-1">
            <span className="text-sm text-slate-300">Server URL</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              required
              placeholder="http://localhost:3000"
              className="w-full rounded bg-slate-800 px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-emerald-500"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-slate-300">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded bg-slate-800 px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-emerald-500"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-slate-300">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded bg-slate-800 px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-emerald-500"
            />
          </label>
          {error ? (
            <p className="text-sm text-rose-400" role="alert">{error}</p>
          ) : null}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:cursor-not-allowed py-2 text-sm font-medium"
          >
            {busy ? 'Working...' : mode === 'login' ? 'Sign in' : 'Register'}
          </button>
          <button
            type="button"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            className="block w-full text-center text-xs text-slate-400 hover:text-slate-200"
          >
            {mode === 'login' ? 'No account? Register' : 'Have an account? Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

interface MatchesViewProps {
  user: AuthUser;
  onSignOut: () => void;
  onOpenMatch: (id: string) => void;
}

function MatchesView({ user, onSignOut, onOpenMatch }: MatchesViewProps) {
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMatches()
      .then((rows) => {
        if (!cancelled) setMatches(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'failed to load matches';
        setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
        <div>
          <h1 className="text-xl font-semibold">PokeChamps</h1>
          <p className="text-xs text-slate-400">Signed in as {user.email}</p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800"
        >
          Sign out
        </button>
      </header>
      <main className="p-6 space-y-4">
        <h2 className="text-lg font-medium">Matches</h2>
        {error ? (
          <p className="text-sm text-rose-400" role="alert">{error}</p>
        ) : matches === null ? (
          <p className="text-sm text-slate-400">Loading...</p>
        ) : matches.length === 0 ? (
          <p className="text-sm text-slate-400">No matches yet. Run the TUI to record some.</p>
        ) : (
          <ul className="space-y-2">
            {matches.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onOpenMatch(m.id)}
                  className="w-full rounded border border-slate-800 bg-slate-900 px-4 py-3 text-left text-sm hover:border-emerald-700 hover:bg-slate-800/70 focus:outline-none focus:ring focus:ring-emerald-500"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-slate-500">
                      {new Date(m.startedAt).toLocaleString()}
                    </span>
                    <span className="text-xs uppercase tracking-wide text-slate-400">
                      {m.outcome ?? 'in progress'}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-slate-500">Me</div>
                      <div>{m.myTeamSpecies?.join(', ') ?? '-'}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">Opp</div>
                      <div>{m.opponentTeamSpecies?.join(', ') ?? '-'}</div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<AuthUser | null>(() =>
    isAuthenticated() ? getCurrentUser() : null,
  );
  const [baseUrl, setBaseUrlState] = useState<string>(() => getBaseUrl());
  // No router — Phase 4.2 is one screen deep. selectedMatchId === null means
  // the list view; setting it opens BattleView.
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);

  function onBaseUrlChange(next: string): void {
    setBaseUrlState(next);
    setBaseUrl(next);
  }

  if (!user) {
    return (
      <AuthView
        baseUrl={baseUrl}
        onBaseUrlChange={onBaseUrlChange}
        onAuthed={setUser}
      />
    );
  }
  if (selectedMatchId !== null) {
    return (
      <BattleView
        matchId={selectedMatchId}
        onBack={() => setSelectedMatchId(null)}
        onSessionExpired={() => {
          setSelectedMatchId(null);
          setUser(null);
        }}
      />
    );
  }
  return (
    <MatchesView
      user={user}
      onSignOut={() => {
        signOut();
        setUser(null);
      }}
      onOpenMatch={(id) => setSelectedMatchId(id)}
    />
  );
}
