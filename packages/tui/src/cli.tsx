import React, { useState } from 'react';
import { render, Box, Text, useApp } from 'ink';
import type { PokemonSet, OpponentEntry, Match } from '@pokechamps/core/domain/types.js';
import { NEUTRAL_FIELD } from '@pokechamps/core/domain/types.js';
import { MainMenu } from './ui/MainMenu.js';
import { TeamPaste } from './ui/TeamPaste.js';
import { TeamPicker } from './ui/TeamPicker.js';
import { OpponentInput } from './ui/OpponentInput.js';
import { BringPicker } from './ui/BringPicker.js';
import { OpponentLeadPicker } from './ui/OpponentLeadPicker.js';
import { BattleScreen } from './ui/BattleScreen.js';
import { TeamBuilder } from './ui/TeamBuilder.js';
import { MatchHistory } from './ui/MatchHistory.js';

type Route =
  | { kind: 'menu' }
  | { kind: 'edit-team' }
  | { kind: 'team-builder' }
  | { kind: 'history' }
  | { kind: 'pick-team' }
  | { kind: 'opponent'; myTeam: PokemonSet[]; teamName: string }
  | { kind: 'bring'; myTeam: PokemonSet[]; opponent: OpponentEntry[]; teamName: string }
  | { kind: 'opponent-lead'; myTeam: PokemonSet[]; opponent: OpponentEntry[]; teamName: string; bring: [number, number, number, number] }
  | { kind: 'battle'; match: Match };

function App() {
  const { exit } = useApp();
  const [route, setRoute] = useState<Route>({ kind: 'menu' });

  if (route.kind === 'menu') {
    return <MainMenu onSelect={k => {
      if (k === 'quit') exit();
      else if (k === 'edit-team') setRoute({ kind: 'edit-team' });
      else if (k === 'team-builder') setRoute({ kind: 'team-builder' });
      else if (k === 'history') setRoute({ kind: 'history' });
      else if (k === 'new-match') setRoute({ kind: 'pick-team' });
    }} />;
  }
  if (route.kind === 'history') {
    return <MatchHistory onExit={() => setRoute({ kind: 'menu' })} />;
  }
  if (route.kind === 'edit-team') {
    return <TeamPaste onDone={() => setRoute({ kind: 'menu' })} onCancel={() => setRoute({ kind: 'menu' })} />;
  }
  if (route.kind === 'team-builder') {
    return <TeamBuilder onDone={() => setRoute({ kind: 'menu' })} onCancel={() => setRoute({ kind: 'menu' })} />;
  }
  if (route.kind === 'pick-team') {
    return <TeamPicker
      onPick={(team, name) => setRoute({ kind: 'opponent', myTeam: team, teamName: name })}
      onCreateNew={() => setRoute({ kind: 'edit-team' })}
      onCancel={() => setRoute({ kind: 'menu' })}
    />;
  }
  if (route.kind === 'opponent') {
    return <OpponentInput
      onDone={opp => setRoute({ kind: 'bring', myTeam: route.myTeam, opponent: opp, teamName: route.teamName })}
      onCancel={() => setRoute({ kind: 'menu' })}
    />;
  }
  if (route.kind === 'bring') {
    return <BringPicker
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
    />;
  }
  if (route.kind === 'battle') {
    return <BattleScreen match={route.match} onEnd={intent => setRoute(intent === 'new-match' ? { kind: 'pick-team' } : { kind: 'menu' })} />;
  }
  return <Text>Unknown route</Text>;
}

render(<App />);
