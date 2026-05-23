import React, { useMemo, useRef, useState } from 'react';
import { render, Box, Text, useApp } from 'ink';
import type { PokemonSet, OpponentEntry, Match } from '@pokechamps/core/domain/types.js';
import { NEUTRAL_FIELD } from '@pokechamps/core/domain/types.js';
import { createFileStores, createHttpStores, type Stores } from '@pokechamps/core/storage/index.js';
import { loadConfig, saveConfig, type PokechampsConfig } from './config.js';
import { MainMenu } from './ui/MainMenu.js';
import { TeamPaste } from './ui/TeamPaste.js';
import { TeamPicker } from './ui/TeamPicker.js';
import { OpponentInput } from './ui/OpponentInput.js';
import { BringPicker } from './ui/BringPicker.js';
import { OpponentLeadPicker } from './ui/OpponentLeadPicker.js';
import { BattleScreen } from './ui/BattleScreen.js';
import { TeamBuilder } from './ui/TeamBuilder.js';
import { MatchHistory } from './ui/MatchHistory.js';
import { ServerSettings } from './ui/ServerSettings.js';
import { TeamManagement } from './ui/TeamManagement.js';
import { AddTeamPicker } from './ui/AddTeamPicker.js';

type Route =
  | { kind: 'menu' }
  | { kind: 'team-management' }
  | { kind: 'add-team' }
  | { kind: 'edit-team'; initialTeam?: PokemonSet[]; initialName?: string; returnTo?: 'menu' | 'team-management' | 'pick-team' }
  | { kind: 'team-builder'; returnTo?: 'menu' | 'team-management' | 'pick-team' }
  | { kind: 'history' }
  | { kind: 'server' }
  // pick-team is now battle-only (entry to a new match). Team browse /
  // edit / export uses team-management → view-existing, which shows the
  // same TeamPicker but routes Enter to edit instead of pick-for-battle.
  | { kind: 'pick-team' }
  | { kind: 'view-teams' }
  | { kind: 'opponent'; myTeam: PokemonSet[]; teamName: string }
  | { kind: 'bring'; myTeam: PokemonSet[]; opponent: OpponentEntry[]; teamName: string }
  | { kind: 'opponent-lead'; myTeam: PokemonSet[]; opponent: OpponentEntry[]; teamName: string; bring: [number, number, number, number] }
  | { kind: 'battle'; match: Match };

function App() {
  const { exit } = useApp();
  const [config, setConfig] = useState<PokechampsConfig>(() => loadConfig());
  const [route, setRoute] = useState<Route>({ kind: 'menu' });

  // The token is read on every request, so we route it through a ref. Logging
  // in mid-session updates the ref without rebuilding stores.
  const tokenRef = useRef<string | null>(config.token ?? null);
  tokenRef.current = config.token ?? null;

  // Stores are rebuilt only when the *transport* changes (file ↔ http or
  // serverUrl change). Token changes don't invalidate the cached instance.
  const stores: Stores = useMemo(() => {
    if (config.serverUrl) {
      return createHttpStores({
        baseUrl: config.serverUrl,
        getToken: () => tokenRef.current,
      });
    }
    return createFileStores();
  }, [config.serverUrl]);

  const onConfigChange = (next: PokechampsConfig) => {
    saveConfig(next);
    setConfig(next);
  };

  if (route.kind === 'menu') {
    const badge: { text: string; color: 'green' | 'yellow' | 'red' } | undefined = config.serverUrl
      ? config.token
        ? { text: `● remote: ${config.serverUrl}${config.email ? ` (${config.email})` : ''}`, color: 'green' }
        : { text: `● remote: ${config.serverUrl} — not signed in`, color: 'red' }
      : { text: '● local file mode', color: 'yellow' };
    return <MainMenu connectionBadge={badge} onSelect={k => {
      if (k === 'quit') exit();
      else if (k === 'team-management') setRoute({ kind: 'team-management' });
      else if (k === 'history') setRoute({ kind: 'history' });
      else if (k === 'server') setRoute({ kind: 'server' });
      else if (k === 'new-match') setRoute({ kind: 'pick-team' });
    }} />;
  }
  if (route.kind === 'team-management') {
    return <TeamManagement onSelect={choice => {
      if (choice === 'view') setRoute({ kind: 'view-teams' });
      else if (choice === 'add') setRoute({ kind: 'add-team' });
      else setRoute({ kind: 'menu' });
    }} />;
  }
  if (route.kind === 'add-team') {
    return <AddTeamPicker onSelect={choice => {
      if (choice === 'interactive') setRoute({ kind: 'team-builder', returnTo: 'team-management' });
      else if (choice === 'import') setRoute({ kind: 'edit-team', returnTo: 'team-management' });
      else setRoute({ kind: 'team-management' });
    }} />;
  }
  if (route.kind === 'view-teams') {
    // Same TeamPicker, but onPick edits instead of starting a battle.
    return <TeamPicker
      stores={stores}
      onPick={(team, name) => setRoute({ kind: 'edit-team', initialTeam: team, initialName: name })}
      onCreateNew={() => setRoute({ kind: 'add-team' })}
      onEdit={(team, name) => setRoute({ kind: 'edit-team', initialTeam: team, initialName: name })}
      // Clone routes to the same edit screen but with a fresh
      // suggested name so saving creates a sibling team rather than
      // overwriting.
      onClone={(team, name) => setRoute({ kind: 'edit-team', initialTeam: team, initialName: name })}
      onCancel={() => setRoute({ kind: 'team-management' })}
    />;
  }
  if (route.kind === 'server') {
    return <ServerSettings
      config={config}
      onConfigChange={onConfigChange}
      onExit={() => setRoute({ kind: 'menu' })}
    />;
  }
  if (route.kind === 'history') {
    return <MatchHistory stores={stores} onExit={() => setRoute({ kind: 'menu' })} />;
  }
  if (route.kind === 'edit-team') {
    const back = route.returnTo ?? 'team-management';
    return <TeamPaste
      stores={stores}
      initialTeam={route.initialTeam}
      initialName={route.initialName}
      onDone={() => setRoute({ kind: back })}
      onCancel={() => setRoute({ kind: back })}
    />;
  }
  if (route.kind === 'team-builder') {
    const back = route.returnTo ?? 'team-management';
    return <TeamBuilder stores={stores} onDone={() => setRoute({ kind: back })} onCancel={() => setRoute({ kind: back })} />;
  }
  if (route.kind === 'pick-team') {
    return <TeamPicker
      stores={stores}
      onPick={(team, name) => setRoute({ kind: 'opponent', myTeam: team, teamName: name })}
      // No teams yet? Route into the add-team flow but return to pick-team
      // after so the user can immediately start the match they were trying
      // to start.
      onCreateNew={() => setRoute({ kind: 'edit-team', returnTo: 'pick-team' })}
      onEdit={(team, name) => setRoute({ kind: 'edit-team', initialTeam: team, initialName: name, returnTo: 'pick-team' })}
      onClone={(team, name) => setRoute({ kind: 'edit-team', initialTeam: team, initialName: name, returnTo: 'pick-team' })}
      onCancel={() => setRoute({ kind: 'menu' })}
    />;
  }
  if (route.kind === 'opponent') {
    return <OpponentInput
      stores={stores}
      onDone={opp => setRoute({ kind: 'bring', myTeam: route.myTeam, opponent: opp, teamName: route.teamName })}
      onCancel={() => setRoute({ kind: 'menu' })}
    />;
  }
  if (route.kind === 'bring') {
    return <BringPicker
      stores={stores}
      myTeam={route.myTeam}
      opponent={route.opponent}
      onConfirm={indices => setRoute({
        kind: 'opponent-lead',
        myTeam: route.myTeam,
        opponent: route.opponent,
        teamName: route.teamName,
        bring: indices,
      })}
      onCancel={() => setRoute({ kind: 'menu' })}
    />;
  }
  if (route.kind === 'opponent-lead') {
    return <OpponentLeadPicker
      stores={stores}
      opponent={route.opponent}
      onConfirm={leadIndices => {
        const match: Match = {
          id: `${Date.now()}`,
          startedAt: new Date().toISOString(),
          myTeam: route.myTeam,
          opponentTeam: route.opponent,
          bring: route.bring as Match['bring'],
          // Seed opponentBrought with just the 2 leads; BattleScreen grows
          // this set as more opp mons appear on the field.
          opponentBrought: leadIndices as Match['opponentBrought'],
          turns: [],
          field: { ...NEUTRAL_FIELD },
          active: { mine: [null, null], theirs: [null, null] },
        };
        setRoute({ kind: 'battle', match });
      }}
      onCancel={() => setRoute({ kind: 'menu' })}
      onBack={() => setRoute({
        // Returning to the bring picker preserves the team + opp so the
        // user only re-picks their 4. The picker re-scores brings off
        // the existing inputs.
        kind: 'bring',
        myTeam: route.myTeam,
        opponent: route.opponent,
        teamName: route.teamName,
      })}
    />;
  }
  if (route.kind === 'battle') {
    return <BattleScreen stores={stores} match={route.match} onEnd={intent => setRoute(intent === 'new-match' ? { kind: 'pick-team' } : { kind: 'menu' })} />;
  }
  return <Text>Unknown route</Text>;
}

// Clear the screen + park the cursor at the top before Ink takes over,
// so the wrapping `npm run` script banners ("> pokechamps@0.1.0 start"
// etc.) don't linger above the UI on startup. ESC[2J = clear screen,
// ESC[H = cursor home. Cheap, no extra dependencies.
process.stdout.write('\x1b[2J\x1b[H');
render(<App />);
