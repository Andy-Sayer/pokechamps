// Engine-level tests for the shared finalizeTurn / applyStateUpdate pipeline.
// Mirrors the orchestration that lives in BattleScreen, run as pure functions
// against synthetic Match fixtures.
import { describe, test, expect } from 'vitest';
import {
  finalizeTurn,
  applyStateUpdate,
  detectOutcome,
  deriveActiveIdx,
  type ActiveIdx,
} from '../src/match/engine.js';
import type {
  Match,
  PokemonSet,
  OpponentEntry,
  MoveAction,
  FieldState,
} from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';
import type { StateUpdate, HazardUpdate } from '../src/domain/turnparser.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return {
    level: 50,
    nature: 'Hardy',
    evs: { ...ZERO_EVS },
    ivs: MAX_IVS,
    ...p,
  };
}

const sneasler: PokemonSet = mon({
  species: 'Sneasler', ability: 'Unburden', nature: 'Jolly',
  evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
  moves: ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect'],
});

const rillaboom: PokemonSet = mon({
  species: 'Rillaboom', ability: 'Grassy Surge', nature: 'Adamant',
  evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 },
  moves: ['Grassy Glide', 'Wood Hammer', 'U-turn', 'Fake Out'],
});

const flutterMane: PokemonSet = mon({
  species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
  evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
  moves: ['Moonblast', 'Shadow Ball', 'Dazzling Gleam', 'Protect'],
});

const ironHands: PokemonSet = mon({
  species: 'Iron Hands', ability: 'Quark Drive', nature: 'Adamant',
  evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 },
  moves: ['Drain Punch', 'Wild Charge', 'Fake Out', 'Protect'],
});

function freshMatch(opts?: {
  myTeam?: PokemonSet[];
  oppSpecies?: string[];
  field?: FieldState;
  opponentBrought?: number[];
}): Match {
  const myTeam = opts?.myTeam ?? [sneasler, rillaboom, ironHands, flutterMane];
  const oppSpecies = opts?.oppSpecies ?? ['Incineroar', 'Amoonguss', 'Garchomp', 'Talonflame'];
  const opponentTeam: OpponentEntry[] = oppSpecies.map(species => ({
    species, knownMoves: [],
  }));
  return {
    id: 'test-match',
    startedAt: '2026-05-20T00:00:00.000Z',
    myTeam,
    opponentTeam,
    bring: [0, 1, 2, 3],
    opponentBrought: (opts?.opponentBrought ?? [0, 1]) as Match['opponentBrought'],
    turns: [],
    field: opts?.field ?? NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
  };
}

const startActive: ActiveIdx = { mine: [0, 1], theirs: [0, 1] };

describe('match engine: finalizeTurn', () => {
  test('opp-attacks-mine action commits my HP and grows opp knownMoves', () => {
    // Inference only runs for mine→theirs damage; opp→mine just updates HP.
    // This is the cheap-and-fast finalize path.
    const match = freshMatch();
    const action: MoveAction = {
      side: 'theirs',
      attackerSlot: 0,
      attackerTeamIndex: 0,
      kind: 'move',
      move: 'Flare Blitz',
      target: { side: 'mine', slot: 0 },
      targetTeamIndex: 0,
      targetRemainingHpPercent: 70,
      order: 1,
    };
    const result = finalizeTurn({
      match, turn: { actions: [action], field: match.field }, activeIdx: startActive,
    });
    expect(result.match.myCurrentHp?.[0]).toBe(70);
    // damageHpPercent derived from prev (100) - new (70) = 30.
    expect(result.match.turns[0]!.actions[0]!.damageHpPercent).toBe(30);
    expect(result.inferenceNotes).toHaveLength(0);
    // Opp knownMoves grows.
    expect(result.match.opponentTeam[0]!.knownMoves).toEqual(['Flare Blitz']);
    // No outcome.
    expect(result.match.outcome).toBeUndefined();
  });

  test('charge move with no damage sets opp.charging; next-turn damage clears it', () => {
    const match = freshMatch();
    // Turn 1: opp commits Solar Beam against my mon, no damage logged.
    const charge: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0,
      kind: 'move', move: 'Solar Beam',
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      order: 1,
    };
    const r1 = finalizeTurn({
      match, turn: { actions: [charge], field: match.field }, activeIdx: startActive,
    });
    expect(r1.match.opponentTeam[0]!.charging?.move).toBe('Solar Beam');
    expect(r1.match.opponentTeam[0]!.charging?.turn).toBe(1);

    // Turn 2: same opp fires for damage. Charging flag clears.
    const fire: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0,
      kind: 'move', move: 'Solar Beam',
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 40,
      order: 1,
    };
    const r2 = finalizeTurn({
      match: r1.match, turn: { actions: [fire], field: r1.match.field }, activeIdx: r1.activeIdx,
    });
    expect(r2.match.opponentTeam[0]!.charging).toBeUndefined();
  });

  test('Power-Herb / sun shortcut: damage logged on charge turn never sets the flag', () => {
    const match = freshMatch();
    const oneshot: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0,
      kind: 'move', move: 'Solar Beam',
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 50,  // damage IS logged → not charging
      order: 1,
    };
    const r = finalizeTurn({
      match, turn: { actions: [oneshot], field: match.field }, activeIdx: startActive,
    });
    expect(r.match.opponentTeam[0]!.charging).toBeUndefined();
  });

  test('non-charge move with no damage (status move) does not set charging', () => {
    const match = freshMatch();
    const status: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0,
      kind: 'move', move: 'Will-O-Wisp',
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      order: 1,
    };
    const r = finalizeTurn({
      match, turn: { actions: [status], field: match.field }, activeIdx: startActive,
    });
    expect(r.match.opponentTeam[0]!.charging).toBeUndefined();
  });

  test('opp-side switch action updates active slot + grows opponentBrought', () => {
    const match = freshMatch();
    const switchAction: MoveAction = {
      side: 'theirs',
      attackerSlot: 0,
      kind: 'switch',
      move: 'Garchomp',
      target: 'self',
      targetTeamIndex: 2,
      order: 1,
    };
    const result = finalizeTurn({
      match, turn: { actions: [switchAction], field: match.field }, activeIdx: startActive,
    });
    expect(result.activeIdx.theirs[0]).toBe(2);
    expect(result.activeIdx.theirs[1]).toBe(1);
    expect(result.match.opponentBrought).toEqual([0, 1, 2]);
  });

  test('pivot move followed by a same-slot switch tags the switch as pivot', () => {
    // U-turn used by mine slot 0, then mine slot 0 switches in another mon.
    // finalizeTurn should set switch.pivot = true so speed inference skips
    // the switch (a forced pivot switch is not a free decision).
    const match = freshMatch();
    const uturn: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, move: 'U-turn',
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 30, order: 1,
    };
    const sw: MoveAction = {
      side: 'mine', attackerSlot: 0, kind: 'switch', move: 'Flutter Mane',
      target: 'self', targetTeamIndex: 3, order: 2,
    };
    const r = finalizeTurn({
      match, turn: { actions: [uturn, sw], field: match.field }, activeIdx: startActive,
    });
    const persisted = r.match.turns[0]!.actions[1]!;
    expect(persisted.kind).toBe('switch');
    expect(persisted.pivot).toBe(true);
  });

  test('mine-side switch onto Stealth Rock subtracts hazard damage', () => {
    // Flutter Mane is neutral to Rock so 12.5% chip on entry.
    const match = freshMatch({
      field: {
        ...NEUTRAL_FIELD,
        myHazards: { rocks: true },
      },
    });
    const switchAction: MoveAction = {
      side: 'mine',
      attackerSlot: 1,
      kind: 'switch',
      move: 'Flutter Mane',
      target: 'self',
      targetTeamIndex: 3,
      order: 1,
    };
    const result = finalizeTurn({
      match, turn: { actions: [switchAction], field: match.field }, activeIdx: startActive,
    });
    expect(result.activeIdx.mine[1]).toBe(3);
    expect(result.match.myCurrentHp?.[3]).toBeCloseTo(87.5, 5);
  });

  test('outcome flips to victory once all brought opps fainted', () => {
    // 4 brought opps; mark 3 fainted in advance, KO the 4th in this turn via
    // a non-inferring action (opp self-damage substitute: use damageRaw=null
    // and targetRemainingHpPercent=0 from "mine" side, but with the move's
    // damage left as null so the inference loop skips it — the HP commit
    // still runs from targetRemainingHpPercent).
    const match = freshMatch({ opponentBrought: [0, 1, 2, 3] });
    for (const i of [0, 1, 2]) {
      match.opponentTeam[i] = { ...match.opponentTeam[i]!, fainted: true, currentHpPercent: 0 };
    }
    // Use a damageHpPercent=100 mine action against Talonflame and skip
    // inference by leaving the attacker's set undiscoverable (the inference
    // loop's outer try/catch handles failures and still pushes a note).
    // Simpler: just record the faint with applyStateUpdate, then verify the
    // outcome detector through finalizeTurn with an empty turn.
    // ... but finalizeTurn early-returns... actually it doesn't. Use the
    // applyStateUpdate fast path instead — it exercises detectOutcome too.
    const result = applyStateUpdate({
      match,
      update: { side: 'theirs', teamIndex: 3, fainted: true },
      activeIdx: { mine: [0, 1], theirs: [null, 3] },
    });
    expect(result.match.opponentTeam[3]!.fainted).toBe(true);
    expect(result.match.outcome).toBe('victory');
    expect(result.activeIdx.theirs[1]).toBeNull();
  });
});

describe('match engine: applyStateUpdate', () => {
  test('hpPercent update on opp reflects in match', () => {
    const match = freshMatch();
    const update: StateUpdate = { side: 'theirs', teamIndex: 0, hpPercent: 42 };
    const result = applyStateUpdate({ match, update, activeIdx: startActive });
    expect(result.match.opponentTeam[0]!.currentHpPercent).toBe(42);
  });

  test('fainted update on opp clears active slot and may end match', () => {
    // Set up: 3 of 4 brought already down, faint the 4th.
    const match = freshMatch({ opponentBrought: [0, 1, 2, 3] });
    for (const i of [0, 1, 2]) {
      match.opponentTeam[i] = { ...match.opponentTeam[i]!, fainted: true, currentHpPercent: 0 };
    }
    const update: StateUpdate = { side: 'theirs', teamIndex: 3, fainted: true };
    const result = applyStateUpdate({
      match, update, activeIdx: { mine: [0, 1], theirs: [null, 3] },
    });
    expect(result.match.opponentTeam[3]!.fainted).toBe(true);
    expect(result.match.opponentTeam[3]!.currentHpPercent).toBe(0);
    expect(result.activeIdx.theirs[1]).toBeNull();
    expect(result.match.outcome).toBe('victory');
  });

  test('hazard update toggles theirHazards on the field', () => {
    const match = freshMatch();
    const update: HazardUpdate = { side: 'theirs', verb: 'rocks', arg: 'on' };
    const result = applyStateUpdate({ match, update, activeIdx: startActive });
    expect(result.match.field?.theirHazards?.rocks).toBe(true);
    // Original match field is not mutated.
    expect(match.field?.theirHazards).toBeUndefined();
  });

  test('boost update on mine clamps and merges per-stat', () => {
    const match = freshMatch();
    match.myBoosts = { 0: { atk: 5 } };
    const update: StateUpdate = {
      side: 'mine', teamIndex: 0, boosts: { atk: 3, def: -2 },
    };
    const result = applyStateUpdate({ match, update, activeIdx: startActive });
    expect(result.match.myBoosts?.[0]?.atk).toBe(6); // clamped from 8
    expect(result.match.myBoosts?.[0]?.def).toBe(-2);
  });

  test('bringIntoSlot triggers hazard application on incoming mon', () => {
    const match = freshMatch({
      field: { ...NEUTRAL_FIELD, myHazards: { rocks: true } },
    });
    const update: StateUpdate = {
      side: 'mine', teamIndex: 2, bringIntoSlot: 0,
    };
    const result = applyStateUpdate({
      match, update, activeIdx: { mine: [0, 1], theirs: [0, 1] },
    });
    expect(result.activeIdx.mine[0]).toBe(2);
    // Iron Hands is Fighting/Electric — Fighting RESISTS Rock (0.5×) and
    // Electric is neutral, so Stealth Rock chip is 12.5 × 0.5 = 6.25% on entry.
    expect(result.match.myCurrentHp?.[2]).toBeCloseTo(93.75, 5);
  });
});

describe('match engine: deriveActiveIdx', () => {
  test('initial actives derived from bring + opponentBrought leads', () => {
    const match = freshMatch();
    const ai = deriveActiveIdx(match);
    expect(ai.mine).toEqual([0, 1]);
    expect(ai.theirs).toEqual([0, 1]);
  });

  test('replays switch actions across turns', () => {
    const match = freshMatch();
    match.turns = [{
      index: 1,
      actions: [{
        side: 'theirs', attackerSlot: 0, kind: 'switch', move: 'Garchomp',
        target: 'self', targetTeamIndex: 2, order: 1,
      }],
      field: match.field,
    }];
    const ai = deriveActiveIdx(match);
    expect(ai.theirs).toEqual([2, 1]);
  });

  test('clears a slot whose occupant has fainted', () => {
    const match = freshMatch();
    match.opponentTeam[0] = { ...match.opponentTeam[0]!, fainted: true };
    const ai = deriveActiveIdx(match);
    expect(ai.theirs[0]).toBeNull();
    expect(ai.theirs[1]).toBe(1);
  });
});

describe('match engine: detectOutcome (defeat path)', () => {
  test('all bring fainted → defeat', () => {
    const match = freshMatch();
    match.myFainted = [0, 1, 2, 3];
    expect(detectOutcome(match)).toBe('defeat');
  });
});

describe('move self-stat drops auto-apply on a hit', () => {
  test('Overheat -2 SpA applies to the user when damage lands', () => {
    const meganium = mon({
      species: 'Meganium', ability: 'Overgrow', nature: 'Modest',
      evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 0 },
      moves: ['Overheat'],
    });
    const match = freshMatch({ myTeam: [meganium, rillaboom, flutterMane, ironHands] });
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move', move: 'Overheat',
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 40, // damage landed
      order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.myBoosts?.[0]?.spa).toBe(-2);
  });

  test('no damage logged → no self-drop applied (the move missed/failed)', () => {
    const meganium = mon({
      species: 'Meganium', ability: 'Overgrow', nature: 'Modest',
      evs: { ...ZERO_EVS, spa: 252 }, moves: ['Overheat'],
    });
    const match = freshMatch({ myTeam: [meganium, rillaboom, flutterMane, ironHands] });
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move', move: 'Overheat',
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.myBoosts?.[0]?.spa).toBeUndefined();
  });
});

describe('drain moves heal the attacker', () => {
  test('opp Giga Drain on my mon heals the opp by 50% of damage dealt', () => {
    const dragger = mon({ species: 'Tangrowth', ability: 'Regenerator', moves: ['Giga Drain'] });
    const myDef = mon({ species: 'Garchomp', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: [] });
    const match = freshMatch({ myTeam: [myDef, sneasler, rillaboom, flutterMane] });
    match.opponentTeam = [{ species: 'Tangrowth', knownMoves: [], currentHpPercent: 50, candidates: [dragger] } as OpponentEntry];
    match.opponentBrought = [0];
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move', move: 'Giga Drain',
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpRaw: 100, // damage amount stored as raw HP — engine derives % from set's max
      damageHpPercent: 20, // explicit damage %: 20% of my mon's max
      order: 1,
    };
    const r = finalizeTurn({
      match, turn: { actions: [action], field: match.field },
      activeIdx: { mine: [0, 1], theirs: [0, 1] },
    });
    expect(r.match.opponentTeam[0]!.currentHpPercent!).toBeGreaterThan(50); // healed
  });
});

describe('Spicy Spray (defender) burns the attacker on a hit', () => {
  test('a non-Fire attacker that hits a Scovillain-Mega holder is auto-burned', () => {
    const scov = mon({ species: 'Scovillain', ability: 'Spicy Spray', item: 'Scovillainite', moves: [] });
    const match = freshMatch({ myTeam: [scov, sneasler, rillaboom, flutterMane], oppSpecies: ['Garchomp', 'Amoonguss'] });
    // Mark Scovillain as already mega'd so defAbility resolves to Spicy Spray.
    match.myMegaUsed = [0]; match.myMegaForme = { 0: 'Scovillain-Mega' };
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move', move: 'Earthquake',
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0, damageHpPercent: 30, order: 1,
    };
    const r = finalizeTurn({
      match, turn: { actions: [action], field: match.field },
      activeIdx: { mine: [0, 1], theirs: [0, 1] },
    });
    expect(r.match.opponentTeam[0]!.status).toBe('brn');
  });

  test('Fire-type attackers are immune (no auto-burn)', () => {
    const scov = mon({ species: 'Scovillain', ability: 'Spicy Spray', item: 'Scovillainite', moves: [] });
    const match = freshMatch({ myTeam: [scov, sneasler, rillaboom, flutterMane], oppSpecies: ['Charizard', 'Amoonguss'] });
    match.myMegaUsed = [0]; match.myMegaForme = { 0: 'Scovillain-Mega' };
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move', move: 'Earthquake',
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0, damageHpPercent: 30, order: 1,
    };
    const r = finalizeTurn({
      match, turn: { actions: [action], field: match.field },
      activeIdx: { mine: [0, 1], theirs: [0, 1] },
    });
    expect(r.match.opponentTeam[0]!.status).toBeUndefined();
  });
});
