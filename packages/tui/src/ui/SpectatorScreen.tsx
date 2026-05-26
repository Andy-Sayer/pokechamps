// Live spectator screen. Owns the share connection: fetches the read-only
// snapshot, subscribes to live frames via ?share=, and renders the full host
// viewpoint through BattleScreen in spectator mode. The friend has no account —
// the share token is the capability. See docs/notes/live-share-plan.md.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Match } from '@pokechamps/core/domain/types.js';
import type { Stores } from '@pokechamps/core/storage/index.js';
import {
  fetchSpectateSnapshot,
  subscribeSpectate,
  type ShareTarget,
  type SpectateStatus,
} from '../spectate.js';
import { BattleScreen } from './BattleScreen.js';

export interface SpectatorScreenProps {
  target: ShareTarget;
  // BattleScreen needs a Stores for pikalytics lookups + render; the spectator
  // never writes, so a read-only-ish store is fine. The parent passes the
  // app's current stores.
  stores: Stores;
  onExit: () => void;
}

const STATUS_LABEL: Record<SpectateStatus, string> = {
  connecting: '○ connecting…',
  live: '● live',
  closed: '× disconnected',
};

export function SpectatorScreen({ target, stores, onExit }: SpectatorScreenProps) {
  const [match, setMatch] = useState<Match | null>(null);
  const [status, setStatus] = useState<SpectateStatus>('connecting');
  const [error, setError] = useState('');

  // Esc leaves while we're still loading/errored (BattleScreen handles Esc once
  // it's mounted, so this only fires on the loading/error screens below).
  useInput((_ch, key) => {
    if (key.escape && (!match || error)) onExit();
  });

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const snap = await fetchSpectateSnapshot(target);
        if (cancelled) return;
        setMatch(snap);
        // Subscribe for live updates; matchId comes from the snapshot.
        stop = subscribeSpectate(target, snap.id, {
          onMatch: m => { if (!cancelled) setMatch(m); },
          onStatus: s => { if (!cancelled) setStatus(s); },
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; if (stop) stop(); };
  }, [target.baseUrl, target.token]);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Couldn't spectate: {error}</Text>
        <Text dimColor>Esc to go back.</Text>
      </Box>
    );
  }
  if (!match) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan">Connecting to shared match…</Text>
        <Text dimColor>Esc to cancel.</Text>
      </Box>
    );
  }

  return (
    <BattleScreen
      stores={stores}
      match={match}
      spectator
      spectatorLabel={STATUS_LABEL[status]}
      onEnd={onExit}
    />
  );
}
