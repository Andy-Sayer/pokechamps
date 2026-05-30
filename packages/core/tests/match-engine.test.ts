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

describe('HP-threshold item auto-triggers (Sitrus, pinch berries)', () => {
  test('Sitrus on my mon auto-heals 25% when a hit drops it below 50%', () => {
    const sitrusMon = mon({
      species: 'Rillaboom', item: 'Sitrus Berry', ability: 'Grassy Surge',
      nature: 'Adamant', evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 },
      moves: ['Grassy Glide'],
    });
    const match = freshMatch({ myTeam: [sitrusMon, sneasler, rillaboom, flutterMane] });
    // Seed mine[0] at 80% HP, then take a hit that lands me at 30%.
    match.myCurrentHp = { 0: 80 };
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Earthquake', target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 30, order: 1,
    };
    const r = finalizeTurn({
      match, turn: { actions: [action], field: match.field },
      activeIdx: { mine: [0, 1], theirs: [0, 1] },
    });
    // Crossed 50% → Sitrus fires → +25% → final 55%.
    expect(r.match.myCurrentHp?.[0]).toBe(55);
    expect(r.match.myItemConsumed?.[0]).toBe('Sitrus Berry');
    // Inference still sees the actual hit damage, not the post-heal residual.
    expect(action.damageHpPercent).toBe(50);
  });

  test('Sitrus does NOT auto-heal when HP stays above 50%', () => {
    const sitrusMon = mon({
      species: 'Rillaboom', item: 'Sitrus Berry', moves: [],
    });
    const match = freshMatch({ myTeam: [sitrusMon, sneasler, rillaboom, flutterMane] });
    match.myCurrentHp = { 0: 90 };
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Bullet Punch', target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 60, order: 1,
    };
    const r = finalizeTurn({
      match, turn: { actions: [action], field: match.field },
      activeIdx: { mine: [0, 1], theirs: [0, 1] },
    });
    expect(r.match.myCurrentHp?.[0]).toBe(60);
    expect(r.match.myItemConsumed?.[0]).toBeUndefined();
  });

  test('Sitrus is not double-consumed when already consumed', () => {
    const sitrusMon = mon({
      species: 'Rillaboom', item: 'Sitrus Berry', moves: [],
    });
    const match = freshMatch({ myTeam: [sitrusMon, sneasler, rillaboom, flutterMane] });
    match.myCurrentHp = { 0: 70 };
    match.myItemConsumed = { 0: 'Sitrus Berry' }; // already gone
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Earthquake', target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 30, order: 1,
    };
    const r = finalizeTurn({
      match, turn: { actions: [action], field: match.field },
      activeIdx: { mine: [0, 1], theirs: [0, 1] },
    });
    // No re-heal — Sitrus already gone.
    expect(r.match.myCurrentHp?.[0]).toBe(30);
  });

  test('Salac Berry on my mon auto-applies +1 Spe at <=25% HP', () => {
    const salacMon = mon({
      species: 'Sneasler', item: 'Salac Berry', ability: 'Unburden',
      nature: 'Jolly', evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
      moves: ['Close Combat'],
    });
    const match = freshMatch({ myTeam: [salacMon, rillaboom, ironHands, flutterMane] });
    match.myCurrentHp = { 0: 50 };
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Earthquake', target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 20, order: 1,
    };
    const r = finalizeTurn({
      match, turn: { actions: [action], field: match.field },
      activeIdx: { mine: [0, 1], theirs: [0, 1] },
    });
    expect(r.match.myCurrentHp?.[0]).toBe(20);
    expect(r.match.myBoosts?.[0]?.spe).toBe(1);
    expect(r.match.myItemConsumed?.[0]).toBe('Salac Berry');
  });

  test('No trigger on a KO (HP hits 0 — berries do not save)', () => {
    const sitrusMon = mon({
      species: 'Rillaboom', item: 'Sitrus Berry', moves: [],
    });
    const match = freshMatch({ myTeam: [sitrusMon, sneasler, rillaboom, flutterMane] });
    match.myCurrentHp = { 0: 80 };
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Earthquake', target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 0, order: 1,
    };
    const r = finalizeTurn({
      match, turn: { actions: [action], field: match.field },
      activeIdx: { mine: [0, 1], theirs: [0, 1] },
    });
    expect(r.match.myCurrentHp?.[0]).toBe(0);
    expect(r.match.myItemConsumed?.[0]).toBeUndefined();
  });

  test('Opp-side: item NOT auto-triggered (opp items are guesses)', () => {
    const match = freshMatch();
    // Pretend the opp at index 0 has a known Sitrus from inference.
    match.opponentTeam[0]!.item = 'Sitrus Berry';
    match.opponentTeam[0]!.currentHpPercent = 80;
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Close Combat', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 30, order: 1,
    };
    const r = finalizeTurn({
      match, turn: { actions: [action], field: match.field },
      activeIdx: { mine: [0, 1], theirs: [0, 1] },
    });
    // HP stays at 30 — we do not auto-fire opp Sitrus (manual `o1 sitrus` line
    // remains the user's override).
    expect(r.match.opponentTeam[0]!.currentHpPercent).toBe(30);
    expect(r.match.opponentTeam[0]!.itemConsumed).toBeUndefined();
  });
});

describe('Status berries auto-cure on status application (my side)', () => {
  test('user-logged Lum Berry cures any status (par) — no status, item consumed', () => {
    const lumMon = mon({
      species: 'Rillaboom', item: 'Lum Berry', ability: 'Grassy Surge',
      moves: ['Grassy Glide'],
    });
    const match = freshMatch({ myTeam: [lumMon, sneasler, ironHands, flutterMane] });
    const update: StateUpdate = { side: 'mine', teamIndex: 0, status: 'par' };
    const r = applyStateUpdate({ match, update, activeIdx: startActive });
    expect(r.match.myStatus?.[0]).toBeUndefined();
    expect(r.match.myItemConsumed?.[0]).toBe('Lum Berry');
  });

  test('Rawst cures brn but Cheri does not (state-line path)', () => {
    const rawstMon = mon({ species: 'Rillaboom', item: 'Rawst Berry', moves: [] });
    const m1 = freshMatch({ myTeam: [rawstMon, sneasler, ironHands, flutterMane] });
    const r1 = applyStateUpdate({ match: m1, update: { side: 'mine', teamIndex: 0, status: 'brn' }, activeIdx: startActive });
    expect(r1.match.myStatus?.[0]).toBeUndefined();
    expect(r1.match.myItemConsumed?.[0]).toBe('Rawst Berry');

    const cheriMon = mon({ species: 'Rillaboom', item: 'Cheri Berry', moves: [] });
    const m2 = freshMatch({ myTeam: [cheriMon, sneasler, ironHands, flutterMane] });
    const r2 = applyStateUpdate({ match: m2, update: { side: 'mine', teamIndex: 0, status: 'brn' }, activeIdx: startActive });
    // Cheri only cures par — burn lands normally.
    expect(r2.match.myStatus?.[0]).toBe('brn');
    expect(r2.match.myItemConsumed?.[0]).toBeUndefined();
  });

  test('no berry → status applies normally', () => {
    const noBerry = mon({
      species: 'Rillaboom', item: 'Leftovers', ability: 'Grassy Surge',
      moves: ['Grassy Glide'],
    });
    const match = freshMatch({ myTeam: [noBerry, sneasler, ironHands, flutterMane] });
    const update: StateUpdate = { side: 'mine', teamIndex: 0, status: 'par' };
    const r = applyStateUpdate({ match, update, activeIdx: startActive });
    expect(r.match.myStatus?.[0]).toBe('par');
    expect(r.match.myItemConsumed?.[0]).toBeUndefined();
  });

  test('Pecha cures Toxic Spikes psn on switch-in', () => {
    const pechaMon = mon({
      species: 'Rillaboom', item: 'Pecha Berry', ability: 'Grassy Surge',
      moves: ['Grassy Glide'],
    });
    // freshMatch defaults mine to Sneasler at index 0; put the Pecha Rillaboom
    // at index 4 (benched) so bringIntoSlot can pull it in cleanly.
    const match = freshMatch({ myTeam: [sneasler, rillaboom, ironHands, flutterMane, pechaMon] });
    // Seed my side with 1 layer of Toxic Spikes.
    match.field = { ...NEUTRAL_FIELD, myHazards: { stealthRock: false, spikes: 0, toxicSpikes: 1, stickyWeb: false } };
    // Switch the Pecha Rillaboom in via the state line.
    const update: StateUpdate = { side: 'mine', teamIndex: 4, bringIntoSlot: 0 };
    const r = applyStateUpdate({ match, update, activeIdx: startActive });
    expect(r.match.myStatus?.[4]).toBeUndefined();
    expect(r.match.myItemConsumed?.[4]).toBe('Pecha Berry');
  });
});

describe('Status moves auto-apply status', () => {
  test('Will-O-Wisp burns opp target', () => {
    // Use Garchomp (Dragon/Ground) — not Fire-type, so burn lands.
    const match = freshMatch({ oppSpecies: ['Garchomp', 'Amoonguss', 'Incineroar', 'Talonflame'] });
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Will-O-Wisp',
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.opponentTeam[0]!.status).toBe('brn');
  });

  test('Will-O-Wisp does NOT burn Fire-type opp', () => {
    // Incineroar is Fire/Dark — immune to burn.
    const match = freshMatch({ oppSpecies: ['Incineroar', 'Amoonguss', 'Garchomp', 'Talonflame'] });
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Will-O-Wisp',
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.opponentTeam[0]!.status).toBeUndefined();
  });

  test('Thunder Wave paralyzes opp target', () => {
    const match = freshMatch({ oppSpecies: ['Amoonguss', 'Garchomp', 'Talonflame', 'Incineroar'] });
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Thunder Wave',
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.opponentTeam[0]!.status).toBe('par');
  });

  test('Spore puts my mon to sleep with 2-turn counter', () => {
    // Opp Amoonguss uses Spore on my Sneasler.
    const match = freshMatch();
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 1, kind: 'move',
      move: 'Spore',
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.myStatus?.[0]).toBe('slp');
    // Counter initialised to 3, decremented to 2 by EOT that same turn.
    expect(r.match.mySleepCounter?.[0]).toBe(2);
  });

  test('Spore does NOT sleep Grass-type target', () => {
    // My Rillaboom (Grass) is immune to powder.
    const match = freshMatch();
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Spore',
      target: { side: 'mine', slot: 1 }, targetTeamIndex: 1, order: 1,
    };
    // Rillaboom is at index 1 (Grass type).
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.myStatus?.[1]).toBeUndefined();
  });

  test('Toxic badly poisons opp and sets toxCounter=1', () => {
    const match = freshMatch({ oppSpecies: ['Garchomp', 'Amoonguss', 'Incineroar', 'Talonflame'] });
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Toxic',
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.opponentTeam[0]!.status).toBe('tox');
    // Counter initialised to 1, incremented to 2 by EOT that same turn.
    expect(r.match.opponentTeam[0]!.toxCounter).toBe(2);
  });

  test('status move does not overwrite existing status', () => {
    const match = freshMatch();
    match.opponentTeam[0]!.status = 'brn';
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Toxic',
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.opponentTeam[0]!.status).toBe('brn'); // unchanged
  });
});

describe('Setup self-boost moves auto-apply stat boosts', () => {
  test('Swords Dance raises my mon atk by +2', () => {
    const match = freshMatch();
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Swords Dance', order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.myBoosts?.[0]?.atk).toBe(2);
  });

  test('Dragon Dance raises opp atk+1 and spe+1', () => {
    const match = freshMatch();
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Dragon Dance', order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    const boosts = r.match.opponentTeam[0]!.currentBoosts ?? {};
    expect(boosts.atk).toBe(1);
    expect(boosts.spe).toBe(1);
  });

  test('boosts stack across turns', () => {
    const match = freshMatch();
    const sdAction: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Swords Dance', order: 1,
    };
    const r1 = finalizeTurn({ match, turn: { actions: [sdAction], field: match.field }, activeIdx: startActive });
    const r2 = finalizeTurn({ match: r1.match, turn: { actions: [sdAction], field: match.field }, activeIdx: startActive });
    expect(r2.match.myBoosts?.[0]?.atk).toBe(4);
  });
});

describe('Recoil moves damage the attacker', () => {
  test('Brave Bird (33% recoil) reduces my HP after a logged hit', () => {
    // Rillaboom (idx 1) uses Brave Bird for 50% damage on opp[0] (Incineroar).
    // Incineroar is estimated at ~300 HP. Rillaboom similar. Recoil ≈ 50%*33%/100 *
    // defMax / atkMax ≈ ~16% but we can't pin exact values so just check direction.
    const match = freshMatch();
    match.myCurrentHp = { 0: 100, 1: 100 };
    const action: MoveAction = {
      side: 'mine', attackerSlot: 1, attackerTeamIndex: 1, kind: 'move',
      move: 'Brave Bird',
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 50, // logged as 50% of opp max HP
      order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    // Rillaboom (attacker, idx 1) should have taken recoil — HP strictly < 100.
    expect(r.match.myCurrentHp![1]).toBeLessThan(100);
  });

  test('Rock Head ability blocks recoil', () => {
    const rockHeadRilla = { ...rillaboom, ability: 'Rock Head' };
    const match = freshMatch({ myTeam: [sneasler, rockHeadRilla, ironHands, flutterMane] });
    match.myCurrentHp = { 0: 100, 1: 100 };
    const action: MoveAction = {
      side: 'mine', attackerSlot: 1, attackerTeamIndex: 1, kind: 'move',
      move: 'Brave Bird',
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 50, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.myCurrentHp![1]).toBe(100); // no recoil
  });
});

describe('On-hit chip abilities (Rough Skin / Iron Barbs)', () => {
  test('contact move on Iron Barbs holder chips the attacker 12.5%', () => {
    // My Sneasler holds Iron Barbs; opp Incineroar uses a contact move on it.
    // This is theirs→mine so inference doesn't run (inference only fires for mine→theirs).
    const ironBarbs = mon({ species: 'Sneasler', ability: 'Iron Barbs', moves: ['Fake Out'] });
    const match = freshMatch({ myTeam: [ironBarbs, rillaboom, ironHands, flutterMane] });
    match.myCurrentHp = { 0: 100, 1: 100 };
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Close Combat', // contact move
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 60, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    // Opp Incineroar (attacker, opp idx 0) took 12.5% chip.
    expect(r.match.opponentTeam[0]!.currentHpPercent).toBeCloseTo(100 - 12.5, 0);
  });

  test('non-contact move does NOT trigger Iron Barbs', () => {
    const ironBarbs = mon({ species: 'Sneasler', ability: 'Iron Barbs', moves: ['Fake Out'] });
    const match = freshMatch({ myTeam: [ironBarbs, rillaboom, ironHands, flutterMane] });
    match.myCurrentHp = { 0: 100, 1: 100 };
    const action: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Flamethrower', // not contact
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 60, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    // Opp attacker took no chip.
    expect(r.match.opponentTeam[0]!.currentHpPercent).toBeUndefined(); // never modified
  });
});

describe('Regenerator heals +1/3 on switch-out', () => {
  test('my Regenerator mon recovers when switched out via a switch action', () => {
    const regenMon = mon({ species: 'Rillaboom', ability: 'Regenerator', moves: ['Grassy Glide'] });
    const match = freshMatch({ myTeam: [sneasler, regenMon, ironHands, flutterMane] });
    match.myCurrentHp = { 0: 100, 1: 50 }; // Rillaboom at 50%
    // Switch action: Rillaboom (outgoing at slot 1) → Iron Hands (idx 2) coming in.
    const action: MoveAction = {
      kind: 'switch', side: 'mine', attackerSlot: 1, targetTeamIndex: 2,
    } as any;
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    // Rillaboom (idx 1) should have recovered 1/3 of max HP ≈ +33.3%.
    expect(r.match.myCurrentHp![1]).toBeCloseTo(50 + 100 / 3, 0);
  });

  test('non-Regenerator mon is not healed on switch-out', () => {
    const match = freshMatch();
    match.myCurrentHp = { 0: 100, 1: 50 };
    const action: MoveAction = {
      kind: 'switch', side: 'mine', attackerSlot: 1, targetTeamIndex: 2,
    } as any;
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.myCurrentHp![1]).toBe(50); // unchanged (Rillaboom has Grassy Surge, not Regen)
  });
});
