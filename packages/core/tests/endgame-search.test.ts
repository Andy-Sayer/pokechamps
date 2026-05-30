// Bounded lookahead search: decisive KO lines, losing positions, turn-order
// awareness, and iterative deepening. Uses real species so predictOffense/
// predictThreat compute real damage; assertions stay on verdict/targets/score
// sign to be robust to exact rolls.
import { describe, test, expect } from 'vitest';
import { searchToDepth, searchIterative, searchInputFromMatch, megaMaxSpeed, type SearchInput } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry, Match } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';
import { maxHpFor } from '../src/domain/damage.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
function oppOf(set: PokemonSet): OpponentEntry {
  return { species: set.species, knownMoves: set.moves, candidates: [set] };
}

const flutter = mon({
  species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
  evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 }, moves: ['Moonblast', 'Shadow Ball'],
});
const garchomp = mon({
  species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly',
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 }, moves: ['Earthquake', 'Dragon Claw'],
});
const incin = mon({
  species: 'Incineroar', ability: 'Intimidate', nature: 'Careful',
  evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 }, moves: ['Knock Off', 'Flare Blitz'],
});

describe('searchToDepth', () => {
  test('recommends a play for each live active and targets a live foe', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 1);
    expect(r.plays.length).toBe(1);
    expect(r.plays[0]!.mySpecies).toBe('Flutter Mane');
    expect(r.plays[0]!.targetSpecies).toBe('Incineroar');
    expect(r.plays[0]!.move).toBeTruthy();
  });

  test('a 1v1 where I outspeed + KO is a winning verdict', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 35, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 2);
    expect(r.verdict).toBe('winning');
    expect(r.score).toBeGreaterThan(0);
  });

  test('1 frail mon vs two healthy attackers is a losing verdict', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 20, active: true }],
      opp: [
        { entry: oppOf(garchomp), hpPercent: 100, active: true },
        { entry: oppOf(incin), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 2);
    expect(r.verdict).toBe('losing');
    expect(r.score).toBeLessThan(0);
  });

  test('no live opponents → no plays (position already won)', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 0, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 3);
    expect(r.plays.length).toBe(0);
  });
});

describe('megaMaxSpeed (conservative opp speed for turn order)', () => {
  test('returns a speed for a mega-capable species, null otherwise', () => {
    const aero = megaMaxSpeed('Aerodactyl');
    expect(aero).not.toBeNull();
    expect(aero!).toBeGreaterThan(150); // mega Aerodactyl is very fast at L50
    // A species with no mega forme.
    expect(megaMaxSpeed('Amoonguss')).toBeNull();
  });
});

describe('mega modelling', () => {
  test('handles mega-capable mons on both sides; megaMon (if set) is mine', () => {
    const megaDelphox = mon({
      species: 'Delphox', item: 'Delphoxite', ability: 'Blaze', nature: 'Timid',
      evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 }, moves: ['Psychic', 'Mystical Fire'],
    });
    const aero = mon({ species: 'Aerodactyl', ability: 'Pressure', moves: ['Rock Slide', 'Stone Edge'] });
    const input: SearchInput = {
      mine: [{ set: megaDelphox, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(aero), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 2);
    expect(r.plays.length).toBe(1);
    expect(r.plays[0]!.mySpecies).toBe('Delphox');
    if (r.megaMon) expect(r.megaMon).toBe('Delphox');
  });
});

describe('spread moves', () => {
  // Delphox with Heat Wave (allAdjacentFoes) vs two foes both weak to it.
  const delphox = mon({
    species: 'Delphox', ability: 'Blaze', nature: 'Timid',
    evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 }, moves: ['Heat Wave', 'Psychic'],
  });
  const abomasnow = mon({ species: 'Abomasnow', ability: 'Snow Warning', moves: ['Blizzard'] });
  const ferrothorn = mon({ species: 'Ferrothorn', ability: 'Iron Barbs', moves: ['Power Whip'] });

  test('recommends the spread move against two foes it hits, targeting all foes', () => {
    const input: SearchInput = {
      mine: [{ set: delphox, hpPercent: 100, active: true }],
      opp: [
        { entry: oppOf(abomasnow), hpPercent: 100, active: true },
        { entry: oppOf(ferrothorn), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 1);
    const play = r.plays.find(p => p.mySpecies === 'Delphox');
    expect(play).toBeTruthy();
    expect(play!.move).toBe('Heat Wave');
    expect(play!.spread).toBe(true);
    expect(play!.targetSpecies).toBe('all foes');
  });
});

describe('searchInputFromMatch', () => {
  function freshMatch(): Match {
    return {
      id: 't', startedAt: '2026-05-26T00:00:00.000Z',
      myTeam: [flutter, garchomp, incin, mon({ species: 'Rillaboom', moves: ['Grassy Glide'] })],
      opponentTeam: ['Incineroar', 'Amoonguss', 'Garchomp', 'Talonflame'].map(species => ({ species, knownMoves: [] } as OpponentEntry)),
      bring: [0, 1, 2, 3], opponentBrought: [0, 1], turns: [], field: { ...NEUTRAL_FIELD },
      active: { mine: [null, null], theirs: [null, null] },
    };
  }

  test('flags an already-mega-evolved opponent as spent + megaActive', () => {
    const m: Match = {
      id: 't', startedAt: '2026-05-26T00:00:00.000Z',
      myTeam: [flutter, garchomp], opponentTeam: [
        { species: 'Aerodactyl', knownMoves: ['Rock Slide'], megaUsed: true, megaForme: 'Aerodactyl-Mega', currentHpPercent: 100 } as OpponentEntry,
        { species: 'Abomasnow', knownMoves: [] } as OpponentEntry,
      ],
      bring: [0, 1], opponentBrought: [0, 1], turns: [], field: { ...NEUTRAL_FIELD },
      active: { mine: [null, null], theirs: [null, null] },
    };
    const input = searchInputFromMatch(m, { mine: [0, 1], theirs: [0, 1] });
    expect(input.oppMegaSpent).toBe(true);
    expect(input.opp[0]!.megaActive).toBe(true);
    expect(input.myMegaSpent).toBeFalsy();
  });

  test('maps actives, bench, raw→% HP, and seen opponents', () => {
    const m = freshMatch();
    m.myFainted = [2];                          // Incineroar fainted → excluded
    m.myCurrentHp = { 1: Math.round(maxHpFor(garchomp) / 2) }; // Garchomp at 50%
    m.opponentTeam[1]!.currentHpPercent = 30;
    const input = searchInputFromMatch(m, { mine: [0, 1], theirs: [0, 1] });

    // 3 live brought mons (Incineroar excluded).
    expect(input.mine.map(x => x.set.species)).toEqual(['Flutter Mane', 'Garchomp', 'Rillaboom']);
    expect(input.mine.find(x => x.set.species === 'Garchomp')!.hpPercent).toBeCloseTo(50, 0);
    expect(input.mine.find(x => x.set.species === 'Flutter Mane')!.active).toBe(true);
    expect(input.mine.find(x => x.set.species === 'Rillaboom')!.active).toBe(false); // benched
    // Only the 2 seen opponents.
    expect(input.opp.map(x => x.entry.species)).toEqual(['Incineroar', 'Amoonguss']);
    expect(input.opp[1]!.hpPercent).toBe(30);
  });

  test('threads live boosts + status onto both sides', () => {
    const m = freshMatch();
    m.myBoosts = { 0: { atk: 2 } };
    m.myStatus = { 0: 'brn' };
    m.opponentTeam[1]!.currentBoosts = { spe: 1 };
    m.opponentTeam[1]!.status = 'par';
    const input = searchInputFromMatch(m, { mine: [0, 1], theirs: [0, 1] });
    const flut = input.mine.find(x => x.set.species === 'Flutter Mane')!;
    expect(flut.boosts).toEqual({ atk: 2 });
    expect(flut.status).toBe('brn');
    expect(input.opp[1]!.boosts).toEqual({ spe: 1 });
    expect(input.opp[1]!.status).toBe('par');
  });
});

describe('honest verdicts: forced gating + probabilistic risks', () => {
  // Flutter Mane guaranteed-OHKOs frail no-mega Meowscarada (147%+), so the opp
  // can't escape via a mega — isolating survival-item / roll / bench effects.
  const meow = mon({ species: 'Meowscarada', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Flower Trick'] });
  const oneVone = (
    survival: { prob: number; label: string } | undefined,
    opts: { oppHp?: number; allRevealed?: boolean } = {},
  ): SearchInput => ({
    mine: [{ set: flutter, hpPercent: 100, active: true }],
    opp: [{ entry: oppOf(meow), hpPercent: opts.oppHp ?? 100, active: true, survival }],
    field: { ...NEUTRAL_FIELD },
    allOppRevealed: opts.allRevealed ?? true,
  });

  test('a likely Focus Sash downgrades a guaranteed-looking OHKO to probabilistic', () => {
    const r = searchToDepth(oneVone({ prob: 0.87, label: 'Focus Sash' }), 1);
    expect(r.verdict).toBe('winning');   // the raw OHKO wins
    expect(r.forced).toBe(false);        // …but a Sash likely saves it
    const sash = r.risks.find(x => x.label.includes('Focus Sash'));
    expect(sash).toBeDefined();
    expect(sash!.prob).toBeCloseTo(0.87, 5);
    expect(sash!.blocking).toBe(true);
    expect(r.winChance).toBeCloseTo(0.13, 5); // 1 − 0.87
  });

  test('no survival item + all revealed + min-roll lethal ⇒ forced win', () => {
    const r = searchToDepth(oneVone(undefined), 1);
    expect(r.verdict).toBe('winning');
    expect(r.forced).toBe(true);
    expect(r.winChance).toBe(1);
  });

  test('unrevealed bench ⇒ never forced, and the caveat is listed', () => {
    const r = searchToDepth(oneVone(undefined, { allRevealed: false }), 1);
    expect(r.forced).toBe(false);
    expect(r.risks.some(x => /switch in/i.test(x.label))).toBe(true);
  });

  test('a roll-dependent KO is not forced and surfaces a damage-roll risk', () => {
    // Single-move Flutter vs no-mega Whimsicott at 66% HP: Moonblast kills at
    // the mid roll but not the low roll → roll-dependent, not forced.
    const flutterMoon = mon({
      species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
      evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 }, moves: ['Moonblast'],
    });
    const whim = mon({ species: 'Whimsicott', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252 }, moves: ['Moonblast'] });
    const input: SearchInput = {
      mine: [{ set: flutterMoon, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(whim), hpPercent: 66, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const r = searchToDepth(input, 1);
    expect(r.forced).toBe(false);
    expect(r.risks.some(x => /KO on .* not guaranteed|damage rolls/.test(x.label))).toBe(true);
    expect(r.winChance!).toBeGreaterThan(0);
    expect(r.winChance!).toBeLessThan(1);
  });
});

describe('multi-hit + bench awareness', () => {
  const meow = mon({ species: 'Meowscarada', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Flower Trick'] });
  const sashMeow = (): SearchInput['opp'] => [
    { entry: oppOf(meow), hpPercent: 100, active: true, survival: { prob: 1, label: 'Focus Sash' } },
  ];

  test('a multi-hit move breaks Focus Sash (no survive-at-1)', () => {
    const aero = mon({ species: 'Aerodactyl', ability: 'Pressure', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Dual Wingbeat'] });
    const multi = searchToDepth({ mine: [{ set: aero, hpPercent: 100, active: true }], opp: sashMeow(), field: { ...NEUTRAL_FIELD }, allOppRevealed: true }, 1);
    expect(multi.verdict).toBe('winning'); // Sash broken by the 2nd hit → KO

    const single = searchToDepth({ mine: [{ set: flutter, hpPercent: 100, active: true }], opp: sashMeow(), field: { ...NEUTRAL_FIELD }, allOppRevealed: true }, 1);
    expect(single.verdict).not.toBe('winning'); // single hit → Sash holds at 1 HP
  });

  test('a dangerous known bench mon surfaces as a concrete switch-in risk', () => {
    const delphox = mon({ species: 'Delphox', item: 'Delphoxite', ability: 'Blaze', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Heat Wave', 'Psychic'] });
    const victreebel = mon({ species: 'Victreebel', ability: 'Chlorophyll', nature: 'Modest', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: ['Power Whip', 'Sludge Bomb'] });
    const m: Match = {
      id: 't', startedAt: '2026-05-28T00:00:00.000Z',
      myTeam: [delphox, victreebel],
      opponentTeam: [
        { species: 'Abomasnow', knownMoves: ['Blizzard'] } as OpponentEntry,
        { species: 'Aerodactyl', knownMoves: ['Rock Slide'] } as OpponentEntry,
        { species: 'Charizard', knownMoves: ['Heat Wave'] } as OpponentEntry, // threatens Grass Victreebel
        { species: 'Blastoise', knownMoves: ['Flip Turn'] } as OpponentEntry,
      ],
      bring: [0, 1], opponentBrought: [0, 1], turns: [], field: { ...NEUTRAL_FIELD },
      active: { mine: [0, 1], theirs: [0, 1] },
    };
    const input = searchInputFromMatch(m, { mine: [0, 1], theirs: [0, 1] });
    expect(input.oppBench?.map(b => b.species)).toEqual(['Charizard', 'Blastoise']);
    const r = searchToDepth(input, 2);
    expect(r.risks.some(x => /switch-in/i.test(x.label) && x.label.includes('Charizard'))).toBe(true);
  });
});

describe('searchIterative', () => {
  test('calls onDepth for each depth 1..max and returns the deepest', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const seen: number[] = [];
    const r = searchIterative(input, 3, res => seen.push(res.depth));
    expect(seen).toEqual([1, 2, 3]);
    expect(r.depth).toBe(3);
  });
});

describe('state-aware: live boosts + status', () => {
  // Incineroar mirror: both bulky (252 HP), hitting each other with physical
  // moves resisted 0.5x (Dark/Fire into Fire/Dark) → deeply sub-OHKO on every
  // variant, so NEITHER side can KO and the depth-1 score is the pure HP delta.
  // That isolates the damage effect of a boost/burn from any terminal-KO cap.

  test('an Atk boost raises my search score (more damage dealt)', () => {
    const base: SearchInput = {
      mine: [{ set: incin, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const boosted: SearchInput = {
      ...base,
      mine: [{ set: incin, hpPercent: 100, active: true, boosts: { atk: 2 } }],
    };
    expect(searchToDepth(boosted, 1).score).toBeGreaterThan(searchToDepth(base, 1).score);
  });

  test('a burn lowers my physical attacker score (halved Atk)', () => {
    const healthy: SearchInput = {
      mine: [{ set: incin, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const burned: SearchInput = {
      ...healthy,
      mine: [{ set: incin, hpPercent: 100, active: true, status: 'brn' }],
    };
    expect(searchToDepth(burned, 1).score).toBeLessThan(searchToDepth(healthy, 1).score);
  });

  test('paralysis flips a winning speed race into a loss (turn order)', () => {
    // Both at 1 HP so any hit KOs — the result hinges purely on who moves first.
    // Opp is a no-mega Incineroar (Jolly 252 Spe = 123) so the search can't
    // dodge the race via a mega plan; Sneasler is 189 (94.5 when paralyzed).
    const sneasler = mon({
      species: 'Sneasler', ability: 'Poison Touch', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Close Combat'],
    });
    const incinFast = mon({
      species: 'Incineroar', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Flare Blitz'],
    });
    const incinEntry: OpponentEntry = { species: 'Incineroar', knownMoves: ['Flare Blitz'], candidates: [incinFast] };
    const base: SearchInput = {
      mine: [{ set: sneasler, hpPercent: 1, active: true }],
      opp: [{ entry: incinEntry, hpPercent: 1, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const par: SearchInput = {
      ...base,
      mine: [{ set: sneasler, hpPercent: 1, active: true, status: 'par' }],
    };
    // Sneasler (189) > Incineroar (123): I KO first → win. Paralyzed (94.5) I am
    // outsped → I am KO'd first → loss.
    expect(searchToDepth(base, 2).verdict).toBe('winning');
    expect(searchToDepth(par, 2).verdict).toBe('losing');
  });
});

describe('hailMary outs analysis', () => {
  const sneasler = mon({
    species: 'Sneasler', ability: 'Poison Touch', nature: 'Jolly',
    evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Close Combat'],
  });
  const incinFast = mon({
    species: 'Incineroar', nature: 'Jolly',
    evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Flare Blitz'],
  });
  const incinEntry = (): SearchInput['opp'][number] => ({
    entry: { species: 'Incineroar', knownMoves: ['Flare Blitz'], candidates: [incinFast] },
    hpPercent: 1, active: true,
  });

  test('hailMary is undefined when verdict is winning', () => {
    const r = searchToDepth({
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 35, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    expect(r.verdict).toBe('winning');
    expect(r.hailMary).toBeUndefined();
  });

  test('hailMary undefined when forced loss (optimistic still loses)', () => {
    // Paralyzed Sneasler at 1% HP vs fast Incineroar at 1% HP: opp goes first,
    // any hit KOs at 1% HP even at min roll → forced loss, no hailMary.
    const r = searchToDepth({
      mine: [{ set: sneasler, hpPercent: 1, active: true, status: 'par' }],
      opp: [incinEntry()],
      field: { ...NEUTRAL_FIELD },
    }, 2);
    expect(r.verdict).toBe('losing');
    expect(r.forced).toBe(true);
    expect(r.hailMary).toBeUndefined();
  });

  test('hailMary structural invariants: combined ∈ [0,1], noRealisticOut ↔ < 0.5%', () => {
    // A losing position (20% HP vs two full-health foes). May or may not be
    // forced — the invariant holds either way.
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 20, active: true }],
      opp: [
        { entry: oppOf(garchomp), hpPercent: 100, active: true },
        { entry: oppOf(incin), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const r = searchToDepth(input, 2);
    expect(r.verdict).toBe('losing');
    if (r.forced) {
      // Forced loss → no hailMary.
      expect(r.hailMary).toBeUndefined();
    } else {
      // Non-forced loss → hailMary is always set.
      expect(r.hailMary).toBeDefined();
      const hm = r.hailMary!;
      expect(hm.combined).toBeGreaterThanOrEqual(0);
      expect(hm.combined).toBeLessThanOrEqual(1);
      expect(hm.noRealisticOut).toBe(hm.combined < 0.005);
      for (const out of hm.outs) {
        expect(out.prob).toBeGreaterThan(0);
        expect(out.prob).toBeLessThanOrEqual(1);
        expect(typeof out.label).toBe('string');
      }
    }
  });

  test('hailMary.plays has valid plays when defined', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 20, active: true }],
      opp: [
        { entry: oppOf(garchomp), hpPercent: 100, active: true },
        { entry: oppOf(incin), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const r = searchToDepth(input, 2);
    if (r.hailMary) {
      expect(r.hailMary.plays.length).toBeLessThanOrEqual(2); // at most MAX_ACTIVE active mons
      for (const p of r.hailMary.plays) {
        expect(p.mySpecies).toBeTruthy();
        expect(p.move).toBeTruthy();
        expect(p.targetSpecies).toBeTruthy();
      }
    }
  });
});
