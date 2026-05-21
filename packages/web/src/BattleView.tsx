// Read-only live battle viewer. Phase 4.2.
//
// Renders the snapshot from GET /matches/:id immediately, then layers in
// updates from the /live WebSocket. No calc / inference here — those need
// the full @smogon/calc dataset and would balloon the bundle.
import { useEffect, useMemo, useState } from 'react';
import type {
  Match,
  MoveAction,
  OpponentEntry,
  PokemonSet,
  TeamSlot,
  Turn,
} from '@pokechamps/core/domain/types.js';
import { ApiError, getBaseUrl, getMatch, getToken, signOut } from './lib/api.js';
import { subscribeLiveMatch, type LiveError, type LiveStatus } from './lib/liveMatch.js';

interface BattleViewProps {
  matchId: string;
  onBack: () => void;
  onSessionExpired: () => void;
}

export function BattleView({ matchId, onBack, onSessionExpired }: BattleViewProps) {
  const [match, setMatch] = useState<Match | null>(null);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMatch(null);
    setError(null);
    setFatal(null);
    setStatus('connecting');

    // Fire the initial fetch and the WS subscribe in parallel — the WS will
    // overwrite with its snapshot frame anyway, but the REST call usually
    // resolves first and lets the UI render without waiting on the upgrade.
    getMatch(matchId)
      .then((m) => {
        if (!cancelled) setMatch(m);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setFatal('match not found');
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          signOut();
          onSessionExpired();
          return;
        }
        const msg = err instanceof Error ? err.message : 'failed to load match';
        setError(msg);
      });

    const token = getToken();
    if (!token) {
      onSessionExpired();
      return () => {
        cancelled = true;
      };
    }

    const sub = subscribeLiveMatch(getBaseUrl(), token, matchId, {
      onMatch: (m) => {
        if (cancelled) return;
        // Same id → simple replace, no merge. The server is the source of truth.
        if (m.id === matchId) setMatch(m);
      },
      onStatus: (s) => {
        if (!cancelled) setStatus(s);
      },
      onError: (err: LiveError) => {
        if (cancelled) return;
        if (err.kind === 'unauthorized') {
          signOut();
          onSessionExpired();
          return;
        }
        if (err.kind === 'not-found') {
          setFatal('match not found');
          return;
        }
        setError(err.message);
      },
    });

    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [matchId, onSessionExpired]);

  if (fatal) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
        <p className="text-sm text-rose-400" role="alert">{fatal}</p>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 rounded border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800"
        >
          Back to matches
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onBack}
            className="rounded border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800"
          >
            ← Matches
          </button>
          <div>
            <h1 className="text-xl font-semibold">Battle</h1>
            <p className="text-xs text-slate-400">
              {match ? new Date(match.startedAt).toLocaleString() : 'loading...'}
              {match?.outcome ? (
                <span className="ml-2 uppercase tracking-wide text-emerald-400">
                  {match.outcome}
                </span>
              ) : null}
            </p>
          </div>
        </div>
        <StatusDot status={status} />
      </header>
      {error ? (
        <div className="border-b border-rose-900/40 bg-rose-950/50 px-6 py-2 text-xs text-rose-300">
          {error}
        </div>
      ) : null}
      <main className="space-y-6 p-6">
        {match ? (
          <>
            <FieldChips match={match} />
            <TeamRow label="Mine" rows={mineRows(match)} />
            <TeamRow label="Theirs" rows={theirRows(match)} />
            <TurnLog match={match} />
          </>
        ) : (
          <p className="text-sm text-slate-400">Loading match...</p>
        )}
      </main>
    </div>
  );
}

function StatusDot({ status }: { status: LiveStatus }) {
  const map: Record<LiveStatus, { color: string; label: string }> = {
    connecting: { color: 'bg-yellow-400', label: 'connecting' },
    live: { color: 'bg-emerald-500', label: 'live' },
    reconnecting: { color: 'bg-yellow-400', label: 'reconnecting' },
    closed: { color: 'bg-rose-500', label: 'disconnected' },
  };
  const { color, label } = map[status];
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

// ---------------- Team rows ----------------

interface TeamCellData {
  species: string;
  hpPercent: number;
  fainted: boolean;
  status?: string;
}

function mineRows(match: Match): TeamCellData[] {
  const bring: TeamSlot[] = match.bring ?? [];
  const fainted = new Set(match.myFainted ?? []);
  const hp = match.myCurrentHp ?? {};
  const stat = match.myStatus ?? {};
  return bring.map((idx) => {
    const set: PokemonSet | undefined = match.myTeam[idx];
    return {
      species: set?.species ?? `slot ${idx}`,
      hpPercent: fainted.has(idx) ? 0 : hp[idx] ?? 100,
      fainted: fainted.has(idx),
      status: stat[idx],
    };
  });
}

function theirRows(match: Match): TeamCellData[] {
  const brought: TeamSlot[] = match.opponentBrought ?? [];
  return brought.map((idx) => {
    const e: OpponentEntry | undefined = match.opponentTeam[idx];
    return {
      species: e?.species ?? `slot ${idx}`,
      hpPercent: e?.fainted ? 0 : e?.currentHpPercent ?? 100,
      fainted: Boolean(e?.fainted),
      status: e?.status,
    };
  });
}

function TeamRow({ label, rows }: { label: string; rows: TeamCellData[] }) {
  return (
    <section>
      <h2 className="mb-2 text-sm uppercase tracking-wide text-slate-400">{label}</h2>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">No mons brought yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {rows.map((r, i) => (
            <TeamCell key={`${label}-${i}`} data={r} />
          ))}
        </div>
      )}
    </section>
  );
}

function TeamCell({ data }: { data: TeamCellData }) {
  const pct = Math.max(0, Math.min(100, Math.round(data.hpPercent)));
  const barColor = pct > 50 ? 'bg-emerald-500' : pct > 20 ? 'bg-yellow-400' : 'bg-rose-500';
  return (
    <div
      className={`rounded border border-slate-800 bg-slate-900 p-3 text-sm ${
        data.fainted ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={data.fainted ? 'line-through' : ''}>{data.species}</span>
        {data.status ? (
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">
            {data.status}
          </span>
        ) : null}
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-slate-800">
        <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-right text-[10px] text-slate-500">{pct}%</div>
    </div>
  );
}

// ---------------- Field state ----------------

function FieldChips({ match }: { match: Match }) {
  const f = match.field;
  const chips: string[] = [];
  if (f.weather) chips.push(f.weather);
  if (f.terrain) chips.push(`${f.terrain} Terrain`);
  if (f.trickRoom) chips.push('Trick Room');
  if (f.myTailwind) chips.push('Tailwind (mine)');
  if (f.theirTailwind) chips.push('Tailwind (theirs)');
  if (f.myReflect) chips.push('Reflect (mine)');
  if (f.myLightScreen) chips.push('Light Screen (mine)');
  if (f.theirReflect) chips.push('Reflect (theirs)');
  if (f.theirLightScreen) chips.push('Light Screen (theirs)');

  const hazards: string[] = [];
  const collect = (side: 'mine' | 'theirs', state?: NonNullable<typeof f.myHazards>): void => {
    if (!state) return;
    const label = side === 'mine' ? 'mine' : 'theirs';
    if (state.rocks) hazards.push(`Rocks (${label})`);
    if (state.spikes) hazards.push(`Spikes x${state.spikes} (${label})`);
    if (state.toxicSpikes) hazards.push(`T-Spikes x${state.toxicSpikes} (${label})`);
    if (state.stickyWeb) hazards.push(`Web (${label})`);
  };
  collect('mine', f.myHazards);
  collect('theirs', f.theirHazards);

  if (chips.length === 0 && hazards.length === 0) return null;

  return (
    <section className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <span
          key={`f-${c}`}
          className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-0.5 text-xs text-slate-200"
        >
          {c}
        </span>
      ))}
      {hazards.map((h) => (
        <span
          key={`h-${h}`}
          className="rounded-full border border-amber-700/60 bg-amber-950/40 px-2.5 py-0.5 text-xs text-amber-200"
        >
          {h}
        </span>
      ))}
    </section>
  );
}

// ---------------- Turn log ----------------

function TurnLog({ match }: { match: Match }) {
  // Last 10 turns, most recent first. We keep the action order (1..N) so the
  // viewer matches the TUI's mental model.
  const turns: Turn[] = useMemo(() => {
    const all = match.turns ?? [];
    return all.slice(-10).reverse();
  }, [match.turns]);

  if (turns.length === 0) {
    return (
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-slate-400">Turns</h2>
        <p className="text-xs text-slate-500">No turns recorded yet.</p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="mb-2 text-sm uppercase tracking-wide text-slate-400">Turns</h2>
      <ol className="space-y-3">
        {turns.map((t) => (
          <li
            key={t.index}
            className="rounded border border-slate-800 bg-slate-900 p-3 text-sm"
          >
            <div className="mb-2 text-xs text-slate-500">Turn {t.index}</div>
            <ul className="space-y-1 text-sm text-slate-200">
              {t.actions.map((a, i) => (
                <li key={i}>{summarizeAction(a, match)}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

function summarizeAction(a: MoveAction, match: Match): string {
  const side = a.side === 'mine' ? 'Mine' : 'Theirs';
  const attacker = resolveActorSpecies(a, a.side, match);
  if (a.kind === 'switch') {
    // For switches, `move` holds the incoming species name.
    return `${side}: ${attacker} switched in → ${a.move}`;
  }
  const target = resolveTargetLabel(a, match);
  const dmg = formatDamage(a);
  const head = `${attacker} → ${a.move}`;
  if (!target) return dmg ? `${head} ${dmg}` : head;
  return dmg ? `${head} → ${target} ${dmg}` : `${head} → ${target}`;
}

function resolveActorSpecies(a: MoveAction, side: 'mine' | 'theirs', match: Match): string {
  if (typeof a.attackerTeamIndex === 'number') {
    if (side === 'mine') {
      return match.myTeam[a.attackerTeamIndex]?.species ?? `mine[${a.attackerTeamIndex}]`;
    }
    return match.opponentTeam[a.attackerTeamIndex]?.species ?? `opp[${a.attackerTeamIndex}]`;
  }
  return side === 'mine' ? 'my mon' : 'opp mon';
}

function resolveTargetLabel(a: MoveAction, match: Match): string | null {
  if (a.target === 'self') return 'self';
  if (a.target === 'allies') return 'allies';
  if (a.target === 'foes') return 'foes';
  if (typeof a.targetTeamIndex === 'number') {
    const targetSide = typeof a.target === 'object' ? a.target.side : null;
    if (targetSide === 'mine') {
      return match.myTeam[a.targetTeamIndex]?.species ?? `mine[${a.targetTeamIndex}]`;
    }
    if (targetSide === 'theirs') {
      return (
        match.opponentTeam[a.targetTeamIndex]?.species ?? `opp[${a.targetTeamIndex}]`
      );
    }
  }
  return null;
}

function formatDamage(a: MoveAction): string {
  if (typeof a.damageHpPercent === 'number') {
    return `(-${Math.round(a.damageHpPercent)}%)`;
  }
  if (typeof a.damageRaw === 'number') {
    return `(-${a.damageRaw})`;
  }
  return '';
}
