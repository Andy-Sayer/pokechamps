// J.0–J.2 replay ingest: parse a REAL Showdown VGC doubles replay (fixture,
// offline) into a BattleTranscript, walk it through the production
// match/engine.ts, and check the legality flags. The fixture is a complete
// Reg F game with open team sheets, spread moves, weather/terrain/Trick Room,
// Intimidate, Tera, faints and a win.
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReplayLog, parsePackedTeam } from '../src/domain/showdownReplay.js';
import { ingestTranscript } from '../src/domain/replayDriver.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'replays', 'gen9vgc2026regfbo3-2573268519.log');
const log = readFileSync(FIXTURE, 'utf8');

describe('J.0 — parseReplayLog on a real VGC replay', () => {
  const t = parseReplayLog(log);

  test('header: players, format, team sizes', () => {
    expect(t.players.p1).toBe('fowlenjoyer');
    expect(t.players.p2).toBe('cubeaoz');
    expect(t.format).toContain('VGC 2026');
    expect(t.gametype).toBe('doubles');
    expect(t.teamSize.p1).toBe(4);
    expect(t.winner).toBe('fowlenjoyer');
  });

  test('teams: 6 per side, open-team-sheet sets resolved to display names', () => {
    expect(t.teams.p1).toHaveLength(6);
    expect(t.teams.p2).toHaveLength(6);
    const ursaluna = t.teams.p1.find(m => m.species === 'Ursaluna-Bloodmoon')!;
    expect(ursaluna.fromTeamSheet).toBe(true);
    expect(ursaluna.item).toBe('Iron Ball');
    expect(ursaluna.ability).toBe("Mind's Eye");
    expect(ursaluna.moves).toEqual(['Hyper Voice', 'Blood Moon', 'Earth Power', 'Protect']);
    expect(ursaluna.level).toBe(50);
    const arcanine = t.teams.p2.find(m => m.species === 'Arcanine-Hisui')!;
    expect(arcanine.item).toBe('Choice Band');
    expect(arcanine.ability).toBe('Intimidate');
  });

  test('lead block: 4 send-outs + send-out weather/terrain effects', () => {
    const leads = t.leadEvents.filter(e => e.kind === 'switch');
    expect(leads).toHaveLength(4);
    expect(t.leadEvents.some(e => e.kind === 'weather' && e.weather === 'Snowscape')).toBe(true);
    expect(t.leadEvents.some(e => e.kind === 'fieldstart' && /Psychic Terrain/.test((e as { effect: string }).effect))).toBe(true);
    // Psychic Seed: enditem + the boost it grants.
    expect(t.leadEvents.some(e => e.kind === 'itemreveal' && (e as { item: string }).item === 'Psychic Seed')).toBe(true);
  });

  test('turn events: spread move with per-target damage, faint, tera', () => {
    expect(t.turns).toHaveLength(4);
    const turn2 = t.turns[1]!;
    const eruption = turn2.events.find(e => e.kind === 'move' && (e as { move: string }).move === 'Eruption')!;
    expect((eruption as { spreadTargets?: unknown[] }).spreadTargets).toHaveLength(2);
    // Ninetales drops to 0 and faints on the spread hit.
    expect(turn2.events.some(e => e.kind === 'damage' && e.fainted)).toBe(true);
    expect(turn2.events.some(e => e.kind === 'faint')).toBe(true);
    // Hatterene terastallized in turn 1.
    expect(t.turns[0]!.events.some(e => e.kind === 'terastallize')).toBe(true);
  });

  test('reveals fold into the team: Leftovers from the heal line, Intimidate from the ability line', () => {
    expect(t.teams.p2.find(m => m.species === 'Baxcalibur')!.item).toBe('Leftovers');
    expect(t.teams.p2.find(m => m.species === 'Arcanine-Hisui')!.ability).toBe('Intimidate');
  });
});

describe('J.1 — engine walk', () => {
  const t = parseReplayLog(log);
  const r = ingestTranscript(t);

  test('all four turns drive through finalizeTurn and the outcome lands', () => {
    expect(r.match.turns).toHaveLength(4);
    expect(r.match.outcome).toBe('victory'); // mySide defaults to p1, who won
  });

  test('faints + final HP reconcile to the transcript', () => {
    const opp = r.match.opponentTeam;
    const faintedSpecies = opp.filter(o => o.fainted).map(o => o.species).sort();
    expect(faintedSpecies).toEqual(['Arcanine-Hisui', 'Baxcalibur', 'Ninetales-Alola', 'Ogerpon-Wellspring']);
    // Torkoal ended turn 3 at 15% (replay truth).
    const torkoalIdx = r.match.myTeam.findIndex(m => m.species === 'Torkoal');
    expect(r.match.myCurrentHp?.[torkoalIdx]).toBe(15);
  });

  test('opp knownMoves grow from the move events', () => {
    const bax = r.match.opponentTeam.find(o => o.species === 'Baxcalibur')!;
    expect(bax.knownMoves.map(m => m)).toContain('Glaive Rush');
  });

  test('legality: a clean game produces no flags; tera is a note', () => {
    expect(r.flags).toEqual([]);
    expect(r.notes.some(n => /terastallized/.test(n))).toBe(true);
  });
});

describe('J.2 — legality flags on synthetic transcripts', () => {
  // A tiny hand-authored doubles log around the real protocol shapes.
  const synthetic = (middle: string) => `|gametype|doubles
|player|p1|alice|1
|player|p2|bob|2
|gen|9
|tier|[Gen 9] VGC Test
|clearpoke
|poke|p1|Garchomp, L50, M|
|poke|p1|Pikachu, L50, M|
|poke|p2|Amoonguss, L50, F|
|poke|p2|Incineroar, L50, M|
|teampreview|4
|start
|switch|p1a: Garchomp|Garchomp, L50, M|100/100
|switch|p1b: Pikachu|Pikachu, L50, M|100/100
|switch|p2a: Amoonguss|Amoonguss, L50, F|100/100
|switch|p2b: Incineroar|Incineroar, L50, M|100/100
|turn|1
${middle}
|win|alice
`;

  test('a move outside the learnset is flagged', () => {
    const t = parseReplayLog(synthetic(
      '|move|p1b: Pikachu|Fleur Cannon|p2a: Amoonguss\n|-damage|p2a: Amoonguss|55/100',
    ));
    const r = ingestTranscript(t);
    expect(r.flags.some(f => f.kind === 'learnset' && f.who === 'Pikachu' && /Fleur Cannon/.test(f.detail))).toBe(true);
  });

  test('a higher-priority move acting after a lower one is flagged', () => {
    const t = parseReplayLog(synthetic([
      '|move|p2a: Amoonguss|Sludge Bomb|p1a: Garchomp',
      '|-damage|p1a: Garchomp|70/100',
      '|move|p1b: Pikachu|Quick Attack|p2a: Amoonguss',
      '|-damage|p2a: Amoonguss|85/100',
    ].join('\n')));
    const r = ingestTranscript(t);
    expect(r.flags.some(f => f.kind === 'order' && f.who === 'Pikachu')).toBe(true);
  });

  test('priority-consistent order produces no order flag', () => {
    const t = parseReplayLog(synthetic([
      '|move|p1b: Pikachu|Quick Attack|p2a: Amoonguss',
      '|-damage|p2a: Amoonguss|85/100',
      '|move|p2a: Amoonguss|Sludge Bomb|p1a: Garchomp',
      '|-damage|p1a: Garchomp|70/100',
    ].join('\n')));
    const r = ingestTranscript(t);
    expect(r.flags.filter(f => f.kind === 'order')).toEqual([]);
  });

  test('switching in a fainted mon is flagged', () => {
    const t = parseReplayLog(synthetic([
      '|move|p2a: Amoonguss|Sludge Bomb|p1b: Pikachu',
      '|-damage|p1b: Pikachu|0 fnt',
      '|faint|p1b: Pikachu',
      '|upkeep',
      '|switch|p1b: Pikachu|Pikachu, L50, M|100/100',
      '|turn|2',
      '|move|p2a: Amoonguss|Sludge Bomb|p1a: Garchomp',
      '|-damage|p1a: Garchomp|60/100',
    ].join('\n')));
    const r = ingestTranscript(t);
    expect(r.flags.some(f => f.kind === 'switch' && f.who === 'Pikachu' && /fainted/.test(f.detail))).toBe(true);
  });
});

describe('corpus smoke — every cached replay parses and ingests clean', () => {
  // The J.5 seed: each fixture under tests/replays/ must parse, drive through
  // the engine without throwing, and produce no legality flags (these are real
  // ladder games — a flag on one is a parser/legality-model bug until shown
  // otherwise). Drop new fixtures in via scripts/fetch-replay.ts.
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'replays');
  const fixtures = readdirSync(dir).filter(f => f.endsWith('.log'));

  test.each(fixtures)('%s', file => {
    const t = parseReplayLog(readFileSync(join(dir, file), 'utf8'));
    expect(t.turns.length).toBeGreaterThan(0);
    expect(t.teams.p1.length).toBeGreaterThan(0);
    const r = ingestTranscript(t);
    expect(r.match.turns.length).toBe(t.turns.length);
    expect(r.flags).toEqual([]);
    // J.3: every observed hit must be reachable (out = our model is wrong /
    // missing a modifier — exactly what this corpus exists to catch).
    expect(r.damage.filter(d => d.verdict === 'out')).toEqual([]);
  });
});

describe('parsePackedTeam', () => {
  test('resolves packed ids to display names and keeps OTS semantics', () => {
    const mons = parsePackedTeam('Smeargle||FocusSash|OwnTempo|TrickRoom,Spore,Decorate,FollowMe|||M|||50|,,,,,Grass');
    expect(mons).toHaveLength(1);
    expect(mons[0]!.species).toBe('Smeargle');
    expect(mons[0]!.item).toBe('Focus Sash');
    expect(mons[0]!.ability).toBe('Own Tempo');
    expect(mons[0]!.moves).toEqual(['Trick Room', 'Spore', 'Decorate', 'Follow Me']);
    expect(mons[0]!.teraType).toBe('Grass');
    expect(mons[0]!.level).toBe(50);
  });
});
