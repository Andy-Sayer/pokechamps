// Bounded lookahead search: decisive KO lines, losing positions, turn-order
// awareness, and iterative deepening. Uses real species so predictOffense/
// predictThreat compute real damage; assertions stay on verdict/targets/score
// sign to be robust to exact rolls.
import { describe, test, expect } from 'vitest';
import { searchToDepth, searchIterative, searchInputFromMatch, megaMaxSpeed, resolveOneTurn, type SearchInput } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry, Match, MoveAction } from '../src/domain/types.js';
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

  // The opponent can only be assumed to Mega-Evolve if it could be holding the
  // stone. Mega Absol (223 Spe) outspeeds + OHKOs Delphox; base Absol (slower)
  // gets KO'd first. So whether the verdict is a win hinges on the item: an
  // Absol holding Scope Lens can't mega → I win; an unknown-item Absol → I might
  // be swept, so the worst-case mega branch keeps it a loss.
  test('opp mega branch is gated on the item being a plausible stone', () => {
    const myDelphox = mon({ species: 'Delphox', item: 'Delphoxite', ability: 'Blaze', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Heat Wave', 'Psychic'] });
    const absol = (entry: Partial<OpponentEntry>): SearchInput => ({
      mine: [{ set: myDelphox, hpPercent: 100, active: true }],
      opp: [{ entry: { species: 'Absol', knownMoves: ['Night Slash'], candidates: [mon({ species: 'Absol', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Night Slash'] })], ...entry }, hpPercent: 45, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    // Holding Scope Lens → cannot mega → Delphox outspeeds + KOs first → win.
    const scope = searchToDepth(absol({ item: 'Scope Lens', candidates: [mon({ species: 'Absol', item: 'Scope Lens', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Night Slash'] })] }), 2);
    expect(scope.verdict).toBe('winning');
    // Item unknown → worst-case Mega Absol outspeeds + OHKOs Delphox → losing.
    const unknown = searchToDepth(absol({ item: undefined, candidates: [mon({ species: 'Absol', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Night Slash'] })] }), 2);
    expect(unknown.verdict).toBe('losing');
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

  // The opponent's spread move must hit BOTH my actives. With a SINGLE opp
  // active, the only way for both of my mons to be KO'd in one turn is a spread
  // move — single-target could KO at most one. So a depth-1 terminal loss here
  // proves the opp spread is modeled.
  test("opp's spread move hits both my actives at once (single opp KOs two)", () => {
    // Two Rock-weak frails at low HP. Aerodactyl (fast) Rock Slides both.
    const fastAero = mon({
      species: 'Aerodactyl', ability: 'Pressure', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Rock Slide'],
    });
    // My mons can't dent Aero enough to KO it first (resisted move, full HP).
    const charizard = mon({ species: 'Charizard', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Flamethrower'] });
    const volcarona = mon({ species: 'Volcarona', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Bug Buzz'] });
    const input: SearchInput = {
      mine: [
        { set: charizard, hpPercent: 45, active: true },
        { set: volcarona, hpPercent: 45, active: true },
      ],
      opp: [{ entry: oppOf(fastAero), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const r = searchToDepth(input, 1);
    // Both my mons KO'd by one Rock Slide → I have 0 live → terminal loss.
    expect(r.verdict).toBe('losing');
    expect(r.score).toBeLessThanOrEqual(-100_000);
  });

  // A spread move hits only the mons ON THE FIELD, never the bench. Three
  // Sableye at 1% HP (2 active, 1 benched) vs a faster Abomasnow's Blizzard:
  // the two actives die, but the BENCHED one is out of range and survives — so
  // it must NOT be a full-team wipe (that was a bug where the spread loop ran
  // over the whole team instead of the active slots).
  test("an opp spread move does NOT reach my benched mons", () => {
    const fragile = (): PokemonSet => mon({ species: 'Sableye', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Foul Play'] });
    const fastAboma: OpponentEntry = { species: 'Abomasnow', knownMoves: ['Blizzard'], candidates: [mon({ species: 'Abomasnow', ability: 'Snow Warning', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Blizzard'] })] };
    const input: SearchInput = {
      mine: [
        { set: fragile(), hpPercent: 1, active: true },
        { set: fragile(), hpPercent: 1, active: true },
        { set: fragile(), hpPercent: 1, active: false }, // benched — out of Blizzard's range
      ],
      opp: [{ entry: fastAboma, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const r = searchToDepth(input, 1);
    // The benched Sableye survives → NOT a terminal team wipe.
    expect(r.score).toBeGreaterThan(-100_000);
  });
});

describe('incoming threat: contingent KO + flinch on my mons', () => {
  // The user's turn-1 position: Delphox + Sableye vs Abomasnow + Aerodactyl.
  // Aerodactyl outspeeds both and its Rock Slide is a spread move that can KO
  // Delphox on a high (mega) roll and flinch either of my mons.
  const delphox = mon({ species: 'Delphox', item: 'Delphoxite', ability: 'Blaze', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Heat Wave', 'Psychic'] });
  const sableye = mon({ species: 'Sableye', item: 'Sitrus Berry', ability: 'Prankster', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Foul Play', 'Will-O-Wisp'] });
  const abomasnow: OpponentEntry = { species: 'Abomasnow', knownMoves: ['Blizzard'] };
  const aero = (status?: string): SearchInput['opp'][number] => ({
    entry: { species: 'Aerodactyl', knownMoves: ['Rock Slide', 'Dual Wingbeat'] }, hpPercent: 100, active: true, status,
  });
  const base = (aeroStatus?: string): SearchInput => ({
    mine: [
      { set: delphox, hpPercent: 100, active: true },
      { set: sableye, hpPercent: 100, active: true },
    ],
    opp: [{ entry: abomasnow, hpPercent: 100, active: true }, aero(aeroStatus)],
    field: { ...NEUTRAL_FIELD },
  });

  test("names the opp's contingent KO on my mon instead of a vague 'damage rolls'", () => {
    const r = searchToDepth(base(), 4);
    // The mega Aerodactyl outspeed+KO on Delphox is surfaced BY NAME.
    expect(r.risks.some(x => /Aerodactyl-Mega can KO Delphox/.test(x.label))).toBe(true);
    // And it must NOT fall back to the old catch-all label.
    expect(r.risks.some(x => x.label === 'damage rolls')).toBe(false);
  });

  test('surfaces a flinch risk on each of my acting mons the opp outspeeds', () => {
    const r = searchToDepth(base(), 1);
    expect(r.risks.some(x => /Delphox can be flinched/.test(x.label) && x.prob === 0.3)).toBe(true);
    // Rock Slide is a spread move, so it also threatens to flinch Sableye.
    expect(r.risks.some(x => /Sableye can be flinched/.test(x.label) && x.prob === 0.3)).toBe(true);
  });

  test('flinch is informational — it does NOT distort the headline winChance', () => {
    // Bronzong (slow, resists Rock) guaranteed-OHKOs a frail Aerodactyl at 10%
    // with Flash Cannon and shrugs off Rock Slide → a forced win. Aerodactyl
    // outspeeds Bronzong and Rock Slide can flinch it, but flinch isn't in the
    // maximin, so it must surface as a non-blocking note WITHOUT cutting winChance.
    const bronzong = mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Flash Cannon'] });
    const fastAero: OpponentEntry = { species: 'Aerodactyl', knownMoves: ['Rock Slide'], candidates: [mon({ species: 'Aerodactyl', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Rock Slide'] })] };
    const r = searchToDepth({
      mine: [{ set: bronzong, hpPercent: 100, active: true }],
      opp: [{ entry: fastAero, hpPercent: 10, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 1);
    expect(r.verdict).toBe('winning');
    expect(r.forced).toBe(true);
    expect(r.winChance).toBe(1);                       // flinch did NOT cut it
    const flinch = r.risks.find(x => /Bronzong can be flinched/.test(x.label));
    expect(flinch).toBeDefined();
    expect(flinch!.blocking).toBe(false);              // informational, not priced
  });

  test('flinch risk is gated on the opponent outspeeding me', () => {
    // Paralysis halves Aerodactyl's speed below Delphox (171) but not Sableye (70):
    // Delphox now acts first → can't be flinched; Sableye still can.
    const r = searchToDepth(base('par'), 1);
    expect(r.risks.some(x => /Delphox can be flinched/.test(x.label))).toBe(false);
    expect(r.risks.some(x => /Sableye can be flinched/.test(x.label))).toBe(true);
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

  test('threads firstTurnOut — true for a fresh lead, false after it moves', () => {
    const m = freshMatch();
    let input = searchInputFromMatch(m, { mine: [0, 1], theirs: [0, 1] });
    expect(input.mine.find(x => x.set.species === 'Flutter Mane')!.firstTurnOut).toBe(true);
    // Flutter Mane (team idx 0) makes a move → no longer first-turn-out.
    m.turns = [{ index: 1, actions: [{ side: 'mine', kind: 'move', attackerTeamIndex: 0 } as MoveAction] }];
    input = searchInputFromMatch(m, { mine: [0, 1], theirs: [0, 1] });
    expect(input.mine.find(x => x.set.species === 'Flutter Mane')!.firstTurnOut).toBe(false);
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

describe('Phase 1/2: explainability, assumptions, break-points, breadth', () => {
  // (a) Opponent forcing line is populated on a losing position so the UI can
  // say "they win via: …".
  test('oppLine names how the opponent beats us when losing', () => {
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
    expect(r.oppLine && r.oppLine.length).toBeGreaterThan(0);
    for (const p of r.oppLine!) {
      expect(p.mySpecies).toBeTruthy();   // the opp actor's species
      expect(p.move).toBeTruthy();
    }
  });

  // (b) A contingent-speed outspeed surfaces as a pivotal assumption. A
  // neutral-nature, 252-Spe mirror always sits strictly inside its own species'
  // 0→252 Speed envelope, so the opponent outspeeds ONLY if it invested Speed.
  test('emits a speed assumption for a contingent-speed KO threat', () => {
    const myDrap = mon({
      species: 'Dragapult', nature: 'Hardy', // neutral Spe
      evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Shadow Ball'],
    });
    const oppDrap: OpponentEntry = { species: 'Dragapult', knownMoves: ['Shadow Ball'] };
    const r = searchToDepth({
      mine: [{ set: myDrap, hpPercent: 30, active: true }],   // low HP → opp's hit can KO
      opp: [{ entry: oppDrap, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    expect(r.assumptions?.some(a => /outspeeds .* only if it invested Speed/.test(a.text))).toBe(true);
  });

  // (c-ko) A roll-dependent KO in the recommended line becomes a 'ko' break-point
  // with the foe's current HP as the cutpoint and a probability in (0,1).
  test('a roll-dependent KO surfaces as a ko break-point with the HP cutpoint', () => {
    const flutterMoon = mon({
      species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
      evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 }, moves: ['Moonblast'],
    });
    const whim = mon({ species: 'Whimsicott', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252 }, moves: ['Moonblast'] });
    const r = searchToDepth({
      mine: [{ set: flutterMoon, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(whim), hpPercent: 66, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 1);
    const bp = r.breakpoints?.find(b => b.direction === 'ko' && b.subject === 'Whimsicott');
    expect(bp).toBeDefined();
    expect(bp!.thresholdHp).toBe(66);
    expect(bp!.prob).toBeGreaterThan(0);
    expect(bp!.prob).toBeLessThan(1);
  });

  // (c-survive) A contingent KO on one of MY mons surfaces as a 'survive'
  // break-point (the user's Rock Slide example): if their hit stays under our
  // HP we live. Mega Aerodactyl can KO full-HP Delphox only on a high roll.
  test('a contingent KO on my mon surfaces as a survive break-point', () => {
    const delphox = mon({ species: 'Delphox', item: 'Delphoxite', ability: 'Blaze', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Heat Wave', 'Psychic'] });
    const sableye = mon({ species: 'Sableye', item: 'Sitrus Berry', ability: 'Prankster', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Foul Play', 'Will-O-Wisp'] });
    const r = searchToDepth({
      mine: [
        { set: delphox, hpPercent: 100, active: true },
        { set: sableye, hpPercent: 100, active: true },
      ],
      opp: [
        { entry: { species: 'Abomasnow', knownMoves: ['Blizzard'] }, hpPercent: 100, active: true },
        { entry: { species: 'Aerodactyl', knownMoves: ['Rock Slide', 'Dual Wingbeat'] }, hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD },
    }, 1);
    const bp = r.breakpoints?.find(b => b.direction === 'survive' && b.subject === 'Delphox');
    expect(bp).toBeDefined();
    expect(bp!.thresholdHp).toBe(100);          // we live if the hit stays under full HP
    expect(bp!.prob).toBeGreaterThan(0);
    expect(bp!.prob).toBeLessThan(1);
  });

  // (d) Breadth report is populated and scope-derived: it reflects the action
  // kinds ACTUALLY in the tree and must NOT claim "switch" in a no-bench 1v1
  // (switches only appear with a live bench).
  test('explored breadth is scope-derived and omits switch in a no-bench 1v1', () => {
    const r = searchToDepth({
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    }, 2);
    expect(r.explored).toBeDefined();
    expect(r.explored!.depth).toBe(2);
    expect(r.explored!.actionClasses).toContain('attack');
    expect(r.explored!.actionClasses).not.toContain('switch');
    expect(r.explored!.myActions).toBeGreaterThanOrEqual(1);
    expect(r.explored!.regimes).toBe(3);
  });
});

describe('Phase 3a: root-ply voluntary switches', () => {
  // Rock-4×-weak Volcarona is doomed against a fast Aerodactyl's Stone Edge
  // (OHKO). Both its partner Aggron (Steel/Rock) and the benched Bronzong
  // (Steel/Psychic) RESIST Rock, so switching Volcarona → Bronzong keeps all
  // three mons alive; attacking loses Volcarona. The maximin should switch.
  // (Two active slots so the post-switch refill doesn't re-add the doomed mon.)
  const volcarona = mon({ species: 'Volcarona', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Bug Buzz', 'Fiery Dance'] });
  const aggron = mon({ species: 'Aggron', ability: 'Sturdy', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Heavy Slam', 'Earthquake'] });
  const bronzong = mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Flash Cannon', 'Body Press'] });
  const fastAero: OpponentEntry = { species: 'Aerodactyl', knownMoves: ['Stone Edge'], candidates: [mon({ species: 'Aerodactyl', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Stone Edge'] })] };

  test('recommends switching a doomed mon to a bench mon that walls the threat', () => {
    const r = searchToDepth({
      mine: [
        { set: volcarona, hpPercent: 100, active: true },
        { set: aggron, hpPercent: 100, active: true },      // Rock-resisting partner stays
        { set: bronzong, hpPercent: 100, active: false },   // benched wall
      ],
      // Two healthy opp mons → no turn-1 KO shortcut, so PRESERVING Volcarona by
      // switching it to a Rock-resisting wall is the materially best line. The
      // partner uses a recoil-FREE set (Knock Off, not Flare Blitz): this test
      // isolates switch-to-wall logic, and recoil would otherwise make the
      // attack-and-trade line competitive in this winning 3-vs-2 (recoil is modelled
      // and validated separately).
      opp: [
        { entry: fastAero, hpPercent: 100, active: true },
        { entry: oppOf(mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Knock Off'] })), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    const sw = r.plays.find(p => p.switch);
    expect(sw).toBeDefined();
    expect(sw!.mySpecies).toBe('Volcarona');
    expect(sw!.targetSpecies).toBe('Bronzong');
    // Switching is offered → the breadth report must say so.
    expect(r.explored!.actionClasses).toContain('switch');
  });

  // A switched-in mon takes the hit aimed at the slot it occupies — no free
  // dodge in doubles. When every mon (active + bench) is OHKO'd by the spread,
  // switching just relocates the loss, so it must NOT be chosen.
  test('does not switch when the bench mon is no safer than attacking', () => {
    const charizard = mon({ species: 'Charizard', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Heat Wave'] });
    const ninetales = mon({ species: 'Ninetales', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Flamethrower'] });
    const slideAero: OpponentEntry = { species: 'Aerodactyl', knownMoves: ['Rock Slide'], candidates: [mon({ species: 'Aerodactyl', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Rock Slide'] })] };
    const r = searchToDepth({
      mine: [
        { set: volcarona, hpPercent: 100, active: true },
        { set: charizard, hpPercent: 100, active: true },   // Rock-weak
        { set: ninetales, hpPercent: 100, active: false },  // Rock-weak bench
      ],
      opp: [{ entry: slideAero, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    expect(r.plays.find(p => p.switch)).toBeUndefined();
  });

  test('a doubles position with a shared bench never double-assigns a switch', () => {
    // 2 actives, 1 live benched mon: at most ONE active may switch into it. The
    // recommended joint must not contain two switches to the same mon.
    const r = searchToDepth({
      mine: [
        { set: volcarona, hpPercent: 100, active: true },
        { set: mon({ species: 'Charizard', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Heat Wave'] }), hpPercent: 100, active: true },
        { set: bronzong, hpPercent: 100, active: false },
      ],
      opp: [{ entry: fastAero, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    const switchTargets = r.plays.filter(p => p.switch).map(p => p.targetSpecies);
    expect(new Set(switchTargets).size).toBe(switchTargets.length); // all distinct
  });

  // Unrevealed-roster (oppBench) switch-ins: the opponent may switch a doomed
  // visible mon to one of its KNOWN-but-unbrought mons. Hydreigon (Dark/Dragon)
  // is OHKO'd by Flutter Mane's Moonblast (Fairy 4×); Heatran (Fire/Steel)
  // resists it. With Heatran benched + <4 revealed, the opp can dodge the OHKO
  // by switching — strictly worse for me. Once all 4 are revealed, oppBench is
  // ignored, so the search is identical with or without it.
  test('opp can switch a doomed mon to an unrevealed-roster wall (gated on <4 revealed)', () => {
    const hydreigon = mon({ species: 'Hydreigon', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Dark Pulse'] });
    const heatran: OpponentEntry = { species: 'Heatran', knownMoves: ['Magma Storm'], candidates: [mon({ species: 'Heatran', ability: 'Flash Fire', nature: 'Modest', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Magma Storm'] })] };
    const base = (allRevealed: boolean, bench?: OpponentEntry[]): SearchInput => ({
      mine: [
        { set: flutter, hpPercent: 100, active: true },
        { set: garchomp, hpPercent: 100, active: true },
      ],
      opp: [
        { entry: oppOf(hydreigon), hpPercent: 100, active: true },
        { entry: oppOf(incin), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: allRevealed, oppBench: bench,
    });
    const withBench = (rev: boolean) => searchToDepth(base(rev, [heatran]), 2).score;
    const noBench = (rev: boolean) => searchToDepth(base(rev), 2).score;

    // While the bring is incomplete, the unrevealed wall is a real opp option →
    // it can only hurt my maximin value (the opp dodges the OHKO).
    expect(withBench(false)).toBeLessThan(noBench(false));
    // Once all 4 are revealed, oppBench is ignored → the search is unchanged.
    expect(withBench(true)).toBe(noBench(true));
  });

  // Regression: a single-target move may only hit a foe ON THE FIELD. Benched /
  // unrevealed mons carry damage cells (for switch-in modelling) but must never
  // be an attack TARGET. Flutter Mane OHKOs the benched Hydreigon (Fairy 4×) but
  // only chips the two Steel actives — the buggy search picked the juicy benched
  // KO ("Moonblast the benched mon"), which is impossible.
  test('never recommends attacking a benched / unrevealed opponent', () => {
    const flutterMoon = mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] });
    const hydreigon: OpponentEntry = { species: 'Hydreigon', knownMoves: ['Dark Pulse'] }; // Fairy 4× — a tempting KO
    const input: SearchInput = {
      mine: [{ set: flutterMoon, hpPercent: 100, active: true }],
      opp: [
        { entry: { species: 'Metagross', knownMoves: ['Bullet Punch'] }, hpPercent: 100, active: true },
        { entry: { species: 'Heatran', knownMoves: ['Magma Storm'] }, hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: false, oppBench: [hydreigon],
    };
    const r = searchToDepth(input, 3);
    const onField = ['Metagross', 'Heatran'];
    for (const p of r.plays) {
      if (p.switch || p.self || p.spread) continue;
      expect(onField).toContain(p.targetSpecies);     // never 'Hydreigon' (benched)
    }
  });
});

describe('Phase 3b: Tailwind / Trick Room as actions', () => {
  // A very slow, very strong sweeper (Glastrier) is outsped by fast foes, so it
  // takes hits before it can act. A Trick Room setter (Bronzong) flips the order
  // for subsequent turns → the slow sweeper moves first. Trick Room must be an
  // offered action, and having it available can only help my maximin value.
  const glastrier = mon({ species: 'Glastrier', ability: 'Chilling Neigh', nature: 'Brave', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, ivs: { ...MAX_IVS, spe: 0 }, moves: ['High Horsepower', 'Icicle Crash'] });
  const bronzongTR = mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, ivs: { ...MAX_IVS, spe: 0 }, moves: ['Trick Room', 'Gyro Ball'] });
  const bronzongNoTR = mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, ivs: { ...MAX_IVS, spe: 0 }, moves: ['Iron Defense', 'Gyro Ball'] });
  const fastFoe = (species: string): SearchInput['opp'][number] => ({
    entry: { species, knownMoves: [], candidates: [mon({ species, nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake'] })] },
    hpPercent: 100, active: true,
  });
  const position = (setter: PokemonSet): SearchInput => ({
    mine: [
      { set: glastrier, hpPercent: 100, active: true },
      { set: setter, hpPercent: 100, active: true },
    ],
    opp: [fastFoe('Dragapult'), fastFoe('Aerodactyl')],
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  });

  test('Trick Room is an offered action when a mon on the field knows it', () => {
    const r = searchToDepth(position(bronzongTR), 2);
    expect(r.explored!.actionClasses).toContain('trickroom');
  });

  test('having Trick Room available never lowers my maximin value', () => {
    // Maximin monotonicity: adding one of MY actions can only help me.
    const withTR = searchToDepth(position(bronzongTR), 3).score;
    const withoutTR = searchToDepth(position(bronzongNoTR), 3).score;
    expect(withTR).toBeGreaterThanOrEqual(withoutTR);
  });

  // Tailwind likewise is offered + integrated. A mon that knows Tailwind exposes
  // the action; the breadth report reflects it (scope-derived wording).
  test('Tailwind is an offered action and surfaces in the breadth report', () => {
    const tailwindMon = mon({ species: 'Talonflame', ability: 'Gale Wings', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Tailwind', 'Brave Bird'] });
    const r = searchToDepth({
      mine: [
        { set: tailwindMon, hpPercent: 100, active: true },
        { set: glastrier, hpPercent: 100, active: true },
      ],
      opp: [fastFoe('Dragapult'), fastFoe('Aerodactyl')],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    expect(r.explored!.actionClasses).toContain('tailwind');
  });

  // Field-effect DURATIONS: a known turn count lets the search stall an effect
  // out. Garchomp (169 Spe) normally outspeeds Incineroar (123), but the opp's
  // Tailwind doubles Incineroar to 246 → it outspeeds + KOs first. At 1 HP each,
  // with the Tailwind down to its LAST turn, Garchomp Protects through it; the
  // Tailwind expires; next turn Garchomp outspeeds and KOs → win. With an
  // UNKNOWN (untracked) duration the Tailwind never expires → Garchomp is outsped
  // forever → loss.
  test('a known Tailwind duration lets the search stall it out (vs permanent)', () => {
    const garchompProtect = mon({ species: 'Garchomp', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake', 'Protect'] });
    const fastIncin: OpponentEntry = { species: 'Incineroar', knownMoves: ['Flare Blitz'], candidates: [mon({ species: 'Incineroar', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Flare Blitz'] })] };
    const pos = (theirTailwindTurns?: number): SearchInput => ({
      mine: [{ set: garchompProtect, hpPercent: 1, active: true }],
      opp: [{ entry: fastIncin, hpPercent: 1, active: true }],
      field: { ...NEUTRAL_FIELD, theirTailwind: true, theirTailwindTurns },
      allOppRevealed: true,
    });
    // One turn of Tailwind left → Protect through it, then outspeed + KO.
    expect(searchToDepth(pos(1), 3).verdict).toBe('winning');
    // Untracked duration → assumed permanent → outsped forever → loss.
    expect(searchToDepth(pos(undefined), 3).verdict).toBe('losing');
  });
});

describe('Leech Seed', () => {
  // An EXISTING Leech Seed drains the seeded mon each turn (and heals the
  // seeder). In an Incineroar mirror where neither side can KO, the ONLY HP
  // movement is the seed — so being seeded scores strictly worse for me.
  test('an existing Leech Seed drains the seeded mon over the search horizon', () => {
    const base: SearchInput = {
      mine: [{ set: incin, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const seeded: SearchInput = {
      ...base,
      mine: [{ set: incin, hpPercent: 100, active: true, seededBy: 0 }], // seeded by opp 0
    };
    expect(searchToDepth(seeded, 3).score).toBeLessThan(searchToDepth(base, 3).score);
  });

  // Leech Seed is an offered action against a non-Grass foe, but Grass types are
  // IMMUNE — so it must NOT be offered when the only foe is Grass.
  test('Leech Seed is offered vs a non-Grass foe but not vs a Grass foe (immunity)', () => {
    const seeder = mon({ species: 'Amoonguss', ability: 'Regenerator', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Leech Seed', 'Pollen Puff'] });
    const vs = (oppSpecies: string): SearchInput => ({
      mine: [{ set: seeder, hpPercent: 100, active: true }],
      opp: [{ entry: { species: oppSpecies, knownMoves: ['Tackle'] }, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(vs('Snorlax'), 1).explored!.actionClasses).toContain('leech');   // Normal — seedable
    expect(searchToDepth(vs('Ferrothorn'), 1).explored!.actionClasses).not.toContain('leech'); // Grass — immune
  });

  // The search VALUES Leech Seed: in a stall where direct damage is negligible,
  // having Leech Seed available strictly improves my maximin value (it chips
  // 1/8 per turn + heals), so the search uses it.
  test('having Leech Seed available improves my value in a stall', () => {
    const dondozo: OpponentEntry = { species: 'Dondozo', knownMoves: ['Wave Crash'], candidates: [mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] })] };
    const stall = (moves: string[]): SearchInput => ({
      mine: [{ set: mon({ species: 'Amoonguss', ability: 'Regenerator', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves }), hpPercent: 100, active: true }],
      opp: [{ entry: dondozo, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    const withLeech = searchToDepth(stall(['Leech Seed', 'Clear Smog']), 3).score;
    const withoutLeech = searchToDepth(stall(['Clear Smog']), 3).score;
    expect(withLeech).toBeGreaterThan(withoutLeech);
  });
});

describe('Protect action', () => {
  // Sneasler (Jolly, 252 Spe, 252 Atk) easily OHKOs Incineroar at 1% HP and
  // goes first (189 > max Incin 123). Incineroar has Protect in its moveset.
  const slowIncinWithProtect = mon({
    species: 'Incineroar', ability: 'Intimidate', nature: 'Careful',
    evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 },
    moves: ['Knock Off', 'Protect'],
  });
  const fastSneasler = mon({
    species: 'Sneasler', ability: 'Poison Touch', nature: 'Jolly',
    evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Close Combat'],
  });
  const sneaslerEntry: OpponentEntry = { species: 'Sneasler', knownMoves: ['Close Combat'], candidates: [fastSneasler] };

  test('recommends Protect for a slow mon at 1% HP that would be KO\'d before acting', () => {
    const input: SearchInput = {
      mine: [{ set: slowIncinWithProtect, hpPercent: 1, active: true }],
      opp: [{ entry: sneaslerEntry, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 1);
    const play = r.plays.find(p => p.mySpecies === 'Incineroar');
    expect(play).toBeDefined();
    expect(play!.move).toBe('Protect');
    expect(play!.self).toBe(true);
    expect(play!.targetSpecies).toBe('Incineroar');
  });

  test('Protect scores higher than attacking when KO is unavoidable otherwise', () => {
    // At depth 1 attacking: Sneasler goes first, KOs Incin, Incin can't fire → score = -WIN.
    // At depth 1 protecting: Incin survives at 1 HP → leaf score ≈ 1 − 100 ≈ -99. Protect wins.
    const noProtect = mon({
      species: 'Incineroar', ability: 'Intimidate', nature: 'Careful',
      evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 },
      moves: ['Knock Off'],
    });
    const rAttack = searchToDepth({
      mine: [{ set: noProtect, hpPercent: 1, active: true }],
      opp: [{ entry: sneaslerEntry, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    }, 1);
    const rProtect = searchToDepth({
      mine: [{ set: slowIncinWithProtect, hpPercent: 1, active: true }],
      opp: [{ entry: sneaslerEntry, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    }, 1);
    // Protect gives a strictly better score than pure attacking in this position.
    expect(rProtect.score).toBeGreaterThan(rAttack.score);
  });

  test('a mon without Protect never gets a self-targeting play', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 1, active: true }],
      opp: [{ entry: sneaslerEntry, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 1);
    expect(r.plays.every(p => !p.self)).toBe(true);
  });

  test('opp with Protect in knownMoves can protect: depth-1 forced OHKO is blocked', () => {
    // Flutter Mane guaranteed-OHKOs Meowscarada normally (see honest-verdicts tests).
    // Once Meowscarada has Protect in knownMoves, the search models opp using it:
    // opp worst-case is to Protect and take 0 damage → depth-1 verdict is no longer a win.
    const meowBase = mon({ species: 'Meowscarada', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Flower Trick', 'Protect'] });
    const withOppProtect: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: { species: 'Meowscarada', knownMoves: ['Flower Trick', 'Protect'], candidates: [meowBase] }, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const withoutOppProtect: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: { species: 'Meowscarada', knownMoves: ['Flower Trick'], candidates: [meowBase] }, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const noProtect = searchToDepth(withoutOppProtect, 1);
    expect(noProtect.forced).toBe(true); // baseline: forced win without opp protect

    const withProtect = searchToDepth(withOppProtect, 1);
    // Opp can protect → my OHKO is blocked this turn → no longer a forced depth-1 win.
    expect(withProtect.forced).toBe(false);
    expect(withProtect.score).toBeLessThan(noProtect.score);
  });

  test('consecutive Protect is not offered: streak resets when a different move is taken', () => {
    // At depth 2 in the slow Incin / fast Sneasler scenario:
    // Turn 1: Protect is chosen (streak 0 → 1).
    // Turn 2: streak = 1 → Protect not eligible → Incin must attack (and Sneasler KOs it).
    // Verify that the depth-2 score is worse than depth-1-protect (since turn 2 forces an attack).
    const input: SearchInput = {
      mine: [{ set: slowIncinWithProtect, hpPercent: 1, active: true }],
      opp: [{ entry: sneaslerEntry, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const d1 = searchToDepth(input, 1);
    const d2 = searchToDepth(input, 2);
    // Depth 2 forces an eventual attack → Incin dies → score drops relative to depth-1-protect.
    expect(d2.score).toBeLessThanOrEqual(d1.score);
  });
});

describe('Boosts: setup, Speed Boost, Baton Pass', () => {
  // Speed Boost (order-only): Espathra is outsped by a faster foe, but Protecting
  // through one turn accrues +1 Spe, flipping the race so it KOs next turn. With
  // a non-Speed-Boost ability the race is never won → loss. (1 HP each so order
  // alone decides the KO.)
  const fastFoe: OpponentEntry = {
    species: 'Dragapult', knownMoves: ['Dragon Darts'],
    candidates: [mon({ species: 'Dragapult', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Dragon Darts'] })],
  };
  const espathra = (ability: string) => mon({
    species: 'Espathra', ability, nature: 'Timid',
    evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Lumina Crash', 'Protect'],
  });
  const speedRace = (ability: string): SearchInput => ({
    mine: [{ set: espathra(ability), hpPercent: 1, active: true }],
    opp: [{ entry: fastFoe, hpPercent: 1, active: true }],
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  });

  test('Speed Boost is an offered/known mechanic and surfaces in the breadth report', () => {
    const r = searchToDepth(speedRace('Speed Boost'), 3);
    expect(r.explored!.actionClasses).toContain('speedboost');
  });

  test('Speed Boost flips a losing speed race once it stacks (vs a plain ability)', () => {
    expect(searchToDepth(speedRace('Speed Boost'), 3).verdict).toBe('winning');
    expect(searchToDepth(speedRace('Competitive'), 3).verdict).toBe('losing');
  });

  // Setup (Swords Dance): a Snorlax mirror where neither side can KO, so the only
  // HP movement is damage dealt. Having Swords Dance lets my Snorlax spend a turn
  // on +2 Atk and then out-damage over the horizon → strictly higher value.
  test('Swords Dance setup raises my value in a no-KO stall', () => {
    const make = (moves: string[]): SearchInput => ({
      mine: [{ set: mon({ species: 'Snorlax', ability: 'Thick Fat', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves }), hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(mon({ species: 'Snorlax', ability: 'Thick Fat', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Body Slam'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    const withSD = searchToDepth(make(['Swords Dance', 'Body Slam']), 3);
    const withoutSD = searchToDepth(make(['Body Slam']), 3);
    expect(withSD.explored!.actionClasses).toContain('setup');
    expect(withSD.score).toBeGreaterThan(withoutSD.score);
  });

  // Baton Pass: a +2 SpA passer that invests 0 SpA (so its own attacks are
  // feeble) hands the boost to a strong special sweeper, which then chips a bulky
  // wall far harder than the raw switch-in would. Both lines spend turn 1 moving
  // the sweeper in, so the ONLY difference is whether the +2 transfers.
  test('Baton Pass transfers boosts to the switch-in (beats a plain switch)', () => {
    const sweeper = mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Modest', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: ['Moonblast'] });
    const passer = (moves: string[]) => mon({ species: 'Sylveon', ability: 'Pixilate', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves });
    const wall: OpponentEntry = { species: 'Blissey', knownMoves: ['Pollen Puff'], candidates: [mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Pollen Puff'] })] };
    const make = (passerMoves: string[]): SearchInput => ({
      mine: [
        { set: passer(passerMoves), hpPercent: 100, active: true, boosts: { spa: 2 } }, // already set up
        { set: sweeper, hpPercent: 100, active: false },
      ],
      opp: [{ entry: wall, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    // Passer has no real attack either way, so BOTH lines bring the sweeper in on
    // turn 1 — withBP via Baton Pass (+2 rides along), withoutBP via plain switch
    // (+2 lost). Isolates the transfer.
    const withBP = searchToDepth(make(['Baton Pass', 'Wish']), 3);
    const withoutBP = searchToDepth(make(['Protect', 'Wish']), 3);
    expect(withBP.explored!.actionClasses).toContain('batonpass');
    expect(withBP.score).toBeGreaterThan(withoutBP.score);
  });
});

describe('Phase 4: screens (Reflect / Light Screen / Aurora Veil)', () => {
  // No-KO stall: bulky Snorlax chips my bulky Grimmsnarl with a physical move but
  // can't KO it, and Grimmsnarl can't KO Snorlax — so the only HP movement is
  // damage dealt, and setting Reflect (cuts physical ~0.667×) saves HP → strictly
  // higher value, and the action is surfaced.
  test('setting Reflect raises value vs a physical attacker', () => {
    const snorlax: OpponentEntry = { species: 'Snorlax', knownMoves: ['Body Slam'], candidates: [mon({ species: 'Snorlax', ability: 'Thick Fat', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Body Slam'] })] };
    const make = (moves: string[]): SearchInput => ({
      mine: [{ set: mon({ species: 'Grimmsnarl', ability: 'Prankster', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves }), hpPercent: 100, active: true }],
      opp: [{ entry: snorlax, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    const withReflect = searchToDepth(make(['Reflect', 'Spirit Break']), 3);
    const withoutReflect = searchToDepth(make(['Spirit Break']), 3);
    expect(withReflect.explored!.actionClasses).toContain('screen');
    expect(withReflect.score).toBeGreaterThan(withoutReflect.score);
  });

  // A known-duration opponent screen can be OUTLASTED: cells bake the screen
  // (reduced damage), but a finite Light Screen expires mid-search so my later
  // hits land at full power → more total damage than a permanent (untracked)
  // screen. Blissey is bulky enough that nothing is KO'd (isolates the chip).
  test('a finite opponent screen is outlasted (more damage than a permanent one)', () => {
    const wall: OpponentEntry = { species: 'Blissey', knownMoves: ['Pollen Puff'], candidates: [mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Pollen Puff'] })] };
    const flutter = mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Modest', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: ['Moonblast'] });
    const make = (turns: number | undefined): SearchInput => ({
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: wall, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD, theirLightScreen: true, theirLightScreenTurns: turns }, allOppRevealed: true,
    });
    const finite = searchToDepth(make(1), 3).score;     // expires next turn → later hits full power
    const permanent = searchToDepth(make(undefined), 3).score; // untracked → assumed up all game
    expect(finite).toBeGreaterThan(permanent);
  });
});

describe('Phase 4: weather (sun/rain damage + Chlorophyll-style speed)', () => {
  // The user's headline case: under SUN, the opponent's Chlorophyll mon doubles
  // its Speed and outspeeds + KOs me. At 1 HP each (order decides), if the sun
  // has only 1 turn left I Protect through it; the sun expires, Chlorophyll's ×2
  // is gone, and I outspeed + KO next turn → win. Permanent (untracked) sun →
  // outsped forever → loss.
  const venusaur: OpponentEntry = {
    species: 'Venusaur', ability: 'Chlorophyll', knownMoves: ['Giga Drain'],
    candidates: [mon({ species: 'Venusaur', ability: 'Chlorophyll', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Giga Drain'] })],
  };
  const garchomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake', 'Protect'] });
  const sunRace = (turns: number | undefined): SearchInput => ({
    mine: [{ set: garchomp, hpPercent: 1, active: true }],
    opp: [{ entry: venusaur, hpPercent: 1, active: true }],
    field: { ...NEUTRAL_FIELD, weather: 'Sun', weatherTurns: turns }, allOppRevealed: true,
  });

  test('stalling out the sun removes a Chlorophyll outspeed (finite sun → win)', () => {
    expect(searchToDepth(sunRace(1), 3).verdict).toBe('winning');
    expect(searchToDepth(sunRace(undefined), 3).verdict).toBe('losing'); // permanent → outsped forever
  });

  // Weather damage: sun boosts my Fire move ×1.5. Permanent sun keeps boosting it
  // over the horizon, so it out-damages a sun that expires after one turn. (vs a
  // bulky wall so nothing is KO'd — isolates the chip.)
  test('sun keeps boosting my Fire move (permanent sun > finite sun)', () => {
    const wall: OpponentEntry = { species: 'Blissey', knownMoves: ['Pollen Puff'], candidates: [mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Pollen Puff'] })] };
    const charizard = mon({ species: 'Charizard', ability: 'Blaze', nature: 'Modest', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: ['Flamethrower'] });
    const make = (turns: number | undefined): SearchInput => ({
      mine: [{ set: charizard, hpPercent: 100, active: true }],
      opp: [{ entry: wall, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD, weather: 'Sun', weatherTurns: turns }, allOppRevealed: true,
    });
    expect(searchToDepth(make(undefined), 3).score).toBeGreaterThan(searchToDepth(make(1), 3).score);
  });

  // Setting weather is an offered action.
  test('a weather-setting move is an offered action', () => {
    const ninetales = mon({ species: 'Ninetales', ability: 'Flash Fire', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Sunny Day', 'Flamethrower'] });
    const r = searchToDepth({
      mine: [{ set: ninetales, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(mon({ species: 'Snorlax', moves: ['Body Slam'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    expect(r.explored!.actionClasses).toContain('weather');
  });
});

describe('Phase 4: terrain (Electric/Grassy/Misty/Psychic)', () => {
  const wall: OpponentEntry = { species: 'Blissey', knownMoves: ['Pollen Puff'], candidates: [mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Pollen Puff'] })] };

  // Electric Terrain boosts a grounded user's Electric move x1.3. Permanent
  // terrain keeps boosting it over the horizon → out-damages one that expires.
  test('Electric Terrain keeps boosting my Electric move (permanent > finite)', () => {
    const magnezone = mon({ species: 'Magnezone', ability: 'Analytic', nature: 'Modest', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: ['Thunderbolt'] });
    const make = (turns: number | undefined): SearchInput => ({
      mine: [{ set: magnezone, hpPercent: 100, active: true }],
      opp: [{ entry: wall, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD, terrain: 'Electric', terrainTurns: turns }, allOppRevealed: true,
    });
    expect(searchToDepth(make(undefined), 3).score).toBeGreaterThan(searchToDepth(make(1), 3).score);
  });

  // Grassy Terrain halves Earthquake against a grounded defender, so my EQ chips
  // a grounded wall LESS under Grassy than on clear ground.
  test('Grassy Terrain halves my Earthquake vs a grounded foe', () => {
    // Passive grounded Blissey so nothing is KO'd — isolates the EQ reduction.
    const garchomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Earthquake'] });
    const make = (terrain: 'Grassy' | null): SearchInput => ({
      mine: [{ set: garchomp, hpPercent: 100, active: true }],
      opp: [{ entry: wall, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD, terrain }, allOppRevealed: true,
    });
    expect(searchToDepth(make(null), 3).score).toBeGreaterThan(searchToDepth(make('Grassy'), 3).score);
  });

  test('a terrain-setting move is an offered action', () => {
    const magnezone = mon({ species: 'Magnezone', ability: 'Analytic', nature: 'Modest', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: ['Electric Terrain', 'Thunderbolt'] });
    const r = searchToDepth({
      mine: [{ set: magnezone, hpPercent: 100, active: true }],
      opp: [{ entry: wall, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    expect(r.explored!.actionClasses).toContain('terrain');
  });
});

describe('Phase 4: end-of-turn residuals', () => {
  // Incineroar mirror (deeply sub-OHKO → no KOs), so the only HP movement is the
  // residual. A POISONED opponent chips itself 1/8 per turn → strictly better for
  // me than a healthy one.
  test('poison drains the opponent over the horizon', () => {
    const base = (oppStatus?: string): SearchInput => ({
      mine: [{ set: incin, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 100, active: true, status: oppStatus }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(base('psn'), 3).score).toBeGreaterThan(searchToDepth(base(undefined), 3).score);
  });

  // Leftovers heals 1/16 per turn. True stall: my Dark Incineroar is IMMUNE to
  // the opp's Psychic move and only carries Taunt (0 damage), so neither side
  // chips the other — only Leftovers moves HP.
  test('Leftovers heals my mon across a stall', () => {
    const psychic: OpponentEntry = { species: 'Bronzong', knownMoves: ['Psychic'], candidates: [mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Psychic'] })] };
    const make = (item?: string): SearchInput => ({
      mine: [{ set: mon({ species: 'Incineroar', item, ability: 'Intimidate', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Taunt'] }), hpPercent: 60, active: true }],
      opp: [{ entry: psychic, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(make('Leftovers'), 3).score).toBeGreaterThan(searchToDepth(make(undefined), 3).score);
  });

  // Magic Guard blocks residual DAMAGE: a poisoned Magic Guard mon takes no chip,
  // so its value is identical to being unpoisoned.
  test('Magic Guard ignores poison chip', () => {
    const make = (status?: string): SearchInput => ({
      mine: [{ set: mon({ species: 'Clefable', ability: 'Magic Guard', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Moonblast'] }), hpPercent: 100, active: true, status }],
      opp: [{ entry: oppOf(incin), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(make('psn'), 3).score).toBe(searchToDepth(make(undefined), 3).score);
  });
});

describe('Inflicted status (Will-O-Wisp / Thunder Wave)', () => {
  // Will-O-Wisp burns a physical attacker → its physical output halves, so a
  // bulky Skeledirge takes much less from Earthquake over the horizon → strictly
  // better than not having it. Also surfaces the 'status' action.
  test('Will-O-Wisp burns a physical attacker and cuts its damage', () => {
    const garchomp: OpponentEntry = { species: 'Garchomp', knownMoves: ['Earthquake'], candidates: [mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake'] })] };
    const make = (moves: string[]): SearchInput => ({
      mine: [{ set: mon({ species: 'Skeledirge', ability: 'Unaware', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves }), hpPercent: 100, active: true }],
      opp: [{ entry: garchomp, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    const withWoW = searchToDepth(make(['Will-O-Wisp', 'Shadow Ball']), 4);
    expect(withWoW.explored!.actionClasses).toContain('status');
    expect(withWoW.score).toBeGreaterThan(searchToDepth(make(['Shadow Ball']), 4).score);
  });

  // Fire types can't be burned → Will-O-Wisp is a no-op vs a Fire attacker, so
  // having it changes nothing.
  test('Will-O-Wisp does nothing to a Fire-type foe (immunity)', () => {
    const incinFire: OpponentEntry = { species: 'Incineroar', knownMoves: ['Knock Off'], candidates: [mon({ species: 'Incineroar', ability: 'Blaze', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Knock Off'] })] };
    const make = (moves: string[]): SearchInput => ({
      mine: [{ set: mon({ species: 'Sableye', ability: 'Prankster', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves }), hpPercent: 100, active: true }],
      opp: [{ entry: incinFire, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(make(['Will-O-Wisp', 'Foul Play']), 3).score).toBe(searchToDepth(make(['Foul Play']), 3).score);
  });

  // Psychic Terrain makes priority moves FAIL vs a grounded target. Azumarill's
  // Aqua Jet (priority) KOs a grounded Garchomp first on clear ground (win), but
  // is blocked under Psychic Terrain → it deals nothing and gets KO'd (loss).
  test('Psychic Terrain blocks a priority move vs a grounded target', () => {
    const garchomp: OpponentEntry = { species: 'Garchomp', knownMoves: ['Earthquake'], candidates: [mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake'] })] };
    const make = (terrain: 'Psychic' | null): SearchInput => ({
      mine: [{ set: mon({ species: 'Azumarill', ability: 'Huge Power', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252, hp: 252 }, moves: ['Aqua Jet'] }), hpPercent: 1, active: true }],
      opp: [{ entry: garchomp, hpPercent: 1, active: true }],
      field: { ...NEUTRAL_FIELD, terrain }, allOppRevealed: true,
    });
    expect(searchToDepth(make(null), 2).verdict).toBe('winning');
    expect(searchToDepth(make('Psychic'), 2).verdict).toBe('losing');
  });
});

describe('P1: recovery moves', () => {
  // True stall: Dark-type Mandibuzz is immune to Bronzong's Psychic (takes 0) and
  // only carries Taunt (0 damage), so neither side chips the other. Starting at
  // 50%, having Roost lets it heal back up → strictly better than not having it.
  test('Roost heals the user across a stall', () => {
    const bronzong: OpponentEntry = { species: 'Bronzong', knownMoves: ['Psychic'], candidates: [mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: ['Psychic'] })] };
    const make = (moves: string[]): SearchInput => ({
      mine: [{ set: mon({ species: 'Mandibuzz', ability: 'Overcoat', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves }), hpPercent: 50, active: true }],
      opp: [{ entry: bronzong, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    const withRoost = searchToDepth(make(['Roost', 'Taunt']), 3);
    expect(withRoost.explored!.actionClasses).toContain('recover');
    expect(withRoost.score).toBeGreaterThan(searchToDepth(make(['Taunt']), 3).score);
  });
});

describe('P1: berries (Sitrus + Lum)', () => {
  // Sitrus heals 25% once HP drops to <=50%. A bulky mirror chips each other
  // small; my Incineroar starting at 51% crosses 50% turn 1 and (with Sitrus)
  // heals back up → strictly better than holding nothing.
  test('Sitrus Berry heals after dropping below 50%', () => {
    const make = (item?: string): SearchInput => ({
      mine: [{ set: mon({ species: 'Incineroar', item, ability: 'Intimidate', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Flare Blitz'] }), hpPercent: 51, active: true }],
      opp: [{ entry: oppOf(mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Flare Blitz'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(make('Sitrus Berry'), 3).score).toBeGreaterThan(searchToDepth(make(undefined), 3).score);
  });

  // A Lum Berry cures a status the moment it lands: a Prankster Sableye's
  // Will-O-Wisp burns my Garchomp, but with Lum the burn is immediately removed
  // (no halved physical, no chip) → strictly better than without it.
  test('Lum Berry cures an inflicted burn', () => {
    const sableye: OpponentEntry = { species: 'Sableye', knownMoves: ['Will-O-Wisp'], candidates: [mon({ species: 'Sableye', ability: 'Prankster', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Will-O-Wisp'] })] };
    const make = (item?: string): SearchInput => ({
      mine: [{ set: mon({ species: 'Garchomp', item, ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Earthquake'] }), hpPercent: 100, active: true }],
      opp: [{ entry: sableye, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(make('Lum Berry'), 3).score).toBeGreaterThan(searchToDepth(make(undefined), 3).score);
  });
});

describe('P1: entry hazards on switch-in', () => {
  // A switch the search WOULD make (preserving a doomed Volcarona behind a wall)
  // costs more when Stealth Rock is up: the incoming Bronzong takes chip on
  // entry, so the same line scores lower than on a clear field.
  test('Stealth Rock chips a switch-in, lowering the switch line', () => {
    const volcarona = mon({ species: 'Volcarona', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Bug Buzz'] });
    const aggron = mon({ species: 'Aggron', ability: 'Sturdy', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Heavy Slam'] });
    const bronzong = mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Flash Cannon'] });
    const fastAero: OpponentEntry = { species: 'Aerodactyl', knownMoves: ['Stone Edge'], candidates: [mon({ species: 'Aerodactyl', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Stone Edge'] })] };
    const make = (rocks: boolean): SearchInput => ({
      mine: [
        { set: volcarona, hpPercent: 100, active: true },
        { set: aggron, hpPercent: 100, active: true },
        { set: bronzong, hpPercent: 100, active: false },
      ],
      opp: [{ entry: fastAero, hpPercent: 100, active: true }, { entry: oppOf(mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Knock Off'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD, myHazards: rocks ? { rocks: true } : undefined }, allOppRevealed: true,
    });
    // Same switch is still best (Bronzong survives), but the entry chip makes the line worth less.
    expect(searchToDepth(make(true), 2).score).toBeLessThan(searchToDepth(make(false), 2).score);
  });
});

describe('P1: Intimidate on switch-in', () => {
  // Switching a doomed Volcarona to a benched Mandibuzz is the best line; when
  // that switch-in has Intimidate it drops the opponents' (physical) Atk, so the
  // incoming Stone Edge / Knock Off hit softer → the line is worth more than with
  // a neutral ability.
  test('an Intimidate switch-in weakens the opp physical attackers', () => {
    const volcarona = mon({ species: 'Volcarona', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Bug Buzz'] });
    const aggron = mon({ species: 'Aggron', ability: 'Sturdy', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Heavy Slam'] });
    const aero: OpponentEntry = { species: 'Aerodactyl', knownMoves: ['Stone Edge'], candidates: [mon({ species: 'Aerodactyl', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Stone Edge'] })] };
    const incinO: OpponentEntry = { species: 'Incineroar', knownMoves: ['Knock Off'], candidates: [mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Knock Off'] })] };
    const make = (ability: string): SearchInput => ({
      mine: [
        { set: volcarona, hpPercent: 100, active: true },
        { set: aggron, hpPercent: 100, active: true },
        { set: mon({ species: 'Mandibuzz', ability, nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Foul Play'] }), hpPercent: 100, active: false },
      ],
      opp: [{ entry: aero, hpPercent: 100, active: true }, { entry: incinO, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(make('Intimidate'), 3).score).toBeGreaterThan(searchToDepth(make('Overcoat'), 3).score);
  });
});

describe('P2: drain heal + contact chip', () => {
  const dondozo = (item?: string): OpponentEntry => ({ species: 'Dondozo', item, ability: 'Unaware', knownMoves: ['Wave Crash'], candidates: [mon({ species: 'Dondozo', item, ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] })] });

  // A Rocky Helmet on the foe chips my CONTACT attacker 1/6 per hit, so the same
  // line scores lower than vs a foe holding nothing. (Earthquake is non-contact;
  // Dragon Claw is contact.)
  test('Rocky Helmet chips my contact attacker', () => {
    const make = (item?: string): SearchInput => ({
      mine: [{ set: mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Dragon Claw'] }), hpPercent: 100, active: true }],
      opp: [{ entry: dondozo(item), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(make('Rocky Helmet'), 3).score).toBeLessThan(searchToDepth(make(undefined), 3).score);
  });

  // A draining move heals the attacker 50% of damage dealt, so at low HP Giga
  // Drain (75 BP + heal) beats the higher-BP non-draining Energy Ball.
  test('Giga Drain heals the attacker (beats a stronger non-drain move at low HP)', () => {
    const make = (move: string): SearchInput => ({
      mine: [{ set: mon({ species: 'Amoonguss', ability: 'Regenerator', nature: 'Modest', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: [move] }), hpPercent: 35, active: true }],
      opp: [{ entry: dondozo(), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(make('Giga Drain'), 3).score).toBeGreaterThan(searchToDepth(make('Energy Ball'), 3).score);
  });
});

describe('P2: Regenerator', () => {
  // Switching a doomed Volcarona (at 55%) out to a wall is the best line; with
  // Regenerator it heals 1/3 on the way out, so the switched-out mon is healthier
  // on the bench → the line is worth more than with a neutral ability.
  test('Regenerator heals the mon that switches out', () => {
    const aggron = mon({ species: 'Aggron', ability: 'Sturdy', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Heavy Slam'] });
    const bronzong = mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Flash Cannon'] });
    const aero: OpponentEntry = { species: 'Aerodactyl', knownMoves: ['Stone Edge'], candidates: [mon({ species: 'Aerodactyl', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Stone Edge'] })] };
    const incinO: OpponentEntry = { species: 'Incineroar', knownMoves: ['Knock Off'], candidates: [mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Knock Off'] })] };
    const make = (ability: string): SearchInput => ({
      mine: [
        { set: mon({ species: 'Volcarona', ability, nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Bug Buzz'] }), hpPercent: 55, active: true },
        { set: aggron, hpPercent: 100, active: true },
        { set: bronzong, hpPercent: 100, active: false },
      ],
      opp: [{ entry: aero, hpPercent: 100, active: true }, { entry: incinO, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(make('Regenerator'), 3).score).toBeGreaterThan(searchToDepth(make('Swarm'), 3).score);
  });
});

describe('self-stat-drop secondaries (Draco Meteor / Contrary / Close Combat)', () => {
  const wall = (): OpponentEntry => oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] }));
  const run = (set: PokemonSet) => resolveOneTurn(
    { mine: [{ set, hpPercent: 100, active: true }], opp: [{ entry: wall(), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
    new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map(),
  ).mine[0]!.boosts;

  test('Draco Meteor drops the user SpA -2', () => {
    expect(run(mon({ species: 'Dragapult', ability: 'Clear Body', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Draco Meteor'] })).spa).toBe(-2);
  });
  test('Contrary inverts the self-drop into +2 SpA', () => {
    expect(run(mon({ species: 'Serperior', ability: 'Contrary', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Leaf Storm'] })).spa).toBe(2);
  });
  test('Close Combat drops the user Def and SpD -1 each', () => {
    const b = run(mon({ species: 'Great Tusk', ability: 'Protosynthesis', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Close Combat'] }));
    expect(b.def).toBe(-1);
    expect(b.spd).toBe(-1);
  });
});

describe('sleep (Spore) + redirection (Rage Powder)', () => {
  const garchomp = () => mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake'] });
  const blissey = (): OpponentEntry => oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] }));

  test('Spore inflicts sleep on the target', () => {
    const out = resolveOneTurn(
      { mine: [{ set: garchomp(), hpPercent: 100, active: true }], opp: [{ entry: oppOf(mon({ species: 'Amoonguss', ability: 'Effect Spore', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252 }, moves: ['Spore'] })), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map(), new Map([[0, { kind: 'status', target: 0 } as const]]),
    );
    expect(out.mine[0]!.status).toBe('slp');
  });

  test('an asleep mon cannot act (its attack does nothing)', () => {
    const out = resolveOneTurn(
      { mine: [{ set: garchomp(), hpPercent: 100, active: true, status: 'slp' }], opp: [{ entry: blissey(), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map(),
    );
    expect(out.opp[0]!.hpPct).toBe(100);     // asleep Garchomp didn't hit Blissey
    expect(out.mine[0]!.status).toBe('slp');  // still asleep (counter ticked 2→1)
  });

  test('a Grass-type is immune to Spore (powder)', () => {
    const out = resolveOneTurn(
      { mine: [{ set: mon({ species: 'Amoonguss', ability: 'Regenerator', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252 }, moves: ['Sludge Bomb'] }), hpPercent: 100, active: true }], opp: [{ entry: oppOf(mon({ species: 'Breloom', ability: 'Technician', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Spore'] })), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map(), new Map([[0, { kind: 'status', target: 0 } as const]]),
    );
    expect(out.mine[0]!.status ?? '').not.toBe('slp');   // Amoonguss is Grass → powder immune
  });

  test('Rage Powder pulls the opponent’s single-target attack onto the user', () => {
    const out = resolveOneTurn(
      {
        mine: [
          { set: mon({ species: 'Amoonguss', ability: 'Regenerator', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Rage Powder', 'Sludge Bomb'] }), hpPercent: 100, active: true },
          { set: mon({ species: 'Flutter Mane', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] }), hpPercent: 100, active: true },
        ],
        opp: [{ entry: oppOf(mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Knock Off'] })), hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'redirect' } as const]]), new Map([[0, { kind: 'attack', target: 1 } as const]]),  // opp aims at Flutter Mane (idx 1)
    );
    expect(out.mine[1]!.hpPct).toBe(100);           // Flutter Mane untouched — attack redirected
    expect(out.mine[0]!.hpPct).toBeLessThan(100);   // Amoonguss took the hit
  });
});

describe('meta gaps: Unburden/White Herb, Fake Out, Aegislash Stance Change', () => {
  const blissey = (): OpponentEntry => oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] }));

  test('White Herb restores Close Combat drops and activates Unburden', () => {
    const out = resolveOneTurn(
      { mine: [{ set: mon({ species: 'Sneasler', ability: 'Unburden', item: 'White Herb', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Close Combat'] }), hpPercent: 100, active: true }], opp: [{ entry: blissey(), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map(),
    );
    expect(out.mine[0]!.boosts.def ?? 0).toBe(0);    // White Herb restored the -1
    expect(out.mine[0]!.unburden).toBe(true);        // item consumed → Unburden active
  });

  test('Fake Out flinches the target (first turn out) so it cannot act', () => {
    const out = resolveOneTurn(
      {
        mine: [{ set: mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Fake Out'] }), hpPercent: 100, active: true, firstTurnOut: true }],
        opp: [{ entry: oppOf(mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Dragon Claw'] })), hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'fakeout', target: 0 } as const]]), new Map([[0, { kind: 'attack', target: 0 } as const]]),
    );
    expect(out.mine[0]!.hpPct).toBe(100);            // Garchomp flinched → no Dragon Claw
    expect(out.opp[0]!.hpPct).toBeLessThan(100);     // Fake Out chip
  });

  test('Covert Cloak blocks the Fake Out flinch (target still acts)', () => {
    // My Garchomp holds Covert Cloak (set.item is read directly); the opp Fake Outs it.
    const out = resolveOneTurn(
      {
        mine: [{ set: mon({ species: 'Garchomp', item: 'Covert Cloak', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Dragon Claw'] }), hpPercent: 100, active: true }],
        opp: [{ entry: { species: 'Incineroar', knownMoves: ['Fake Out'], candidates: [mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Fake Out'] })] }, hpPercent: 100, active: true, firstTurnOut: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map([[0, { kind: 'fakeout', target: 0 } as const]]),
    );
    expect(out.opp[0]!.hpPct).toBeLessThan(100);    // Covert Cloak → Garchomp not flinched → Dragon Claw lands
  });

  test('Aegislash hits harder in its Blade forme (Stance Change)', () => {
    // Garchomp (Dragon/Ground) takes neutral Ghost damage — Blissey is Ghost-immune.
    const target = (): OpponentEntry => oppOf(mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Earthquake'] }));
    const dmgVs = (ability: string) => resolveOneTurn(
      { mine: [{ set: mon({ species: 'Aegislash', ability, nature: 'Quiet', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Shadow Ball'] }), hpPercent: 100, active: true }], opp: [{ entry: target(), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map(),
    ).opp[0]!.hpPct;
    expect(dmgVs('Stance Change')).toBeLessThan(dmgVs('Battle Armor'));   // Blade (spa 150) > Shield (spa 50)
  });
});

describe('Taunt + Encore (option restriction)', () => {
  const grass = (moves: string[]) => mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves });
  const blissey = (): OpponentEntry => oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] }));

  test('Taunt is applied to the target (3 turns)', () => {
    const out = resolveOneTurn(
      { mine: [{ set: grass(['Earthquake']), hpPercent: 100, active: true }], opp: [{ entry: oppOf(mon({ species: 'Whimsicott', ability: 'Prankster', nature: 'Timid', evs: { ...ZERO_EVS, spe: 252 }, moves: ['Taunt'] })), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map(), new Map([[0, { kind: 'taunt', target: 0 } as const]]),
    );
    expect(out.mine[0]!.taunt).toBe(3);
  });

  test('Encore locks the target that just attacked (3 turns)', () => {
    const out = resolveOneTurn(
      { mine: [{ set: grass(['Earthquake']), hpPercent: 100, active: true }], opp: [{ entry: oppOf(mon({ species: 'Whimsicott', ability: 'Prankster', nature: 'Timid', evs: { ...ZERO_EVS, spe: 252 }, moves: ['Encore'] })), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map([[0, { kind: 'encore', target: 0 } as const]]),
    );
    expect(out.mine[0]!.encore).toBe(3);
  });

  test('taunt + encore action classes are offered', () => {
    const r = searchToDepth({
      mine: [{ set: mon({ species: 'Whimsicott', ability: 'Prankster', nature: 'Timid', evs: { ...ZERO_EVS, spe: 252 }, moves: ['Taunt', 'Encore', 'Moonblast'] }), hpPercent: 100, active: true }],
      opp: [{ entry: blissey(), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 1);
    expect(r.explored!.actionClasses).toContain('taunt');
    expect(r.explored!.actionClasses).toContain('encore');
  });
});

describe('Unaware + dedicated debuff moves (Charm)', () => {
  test('Unaware ignores the attacker’s boost (takes less than a non-Unaware mon)', () => {
    const hpVs = (ability: string) => resolveOneTurn(
      {
        mine: [{ set: mon({ species: 'Dondozo', ability, nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] }), hpPercent: 100, active: true }],
        opp: [{ entry: oppOf(mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Earthquake'] })), hpPercent: 100, active: true, boosts: { atk: 2 } }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map(), new Map([[0, { kind: 'attack', target: 0 } as const]]),
    ).mine[0]!.hpPct;
    expect(hpVs('Unaware')).toBeGreaterThan(hpVs('Oblivious'));   // +2 Atk ignored vs Unaware
  });

  test('Charm lowers the foe Atk by 2', () => {
    const out = resolveOneTurn(
      {
        mine: [{ set: mon({ species: 'Clefable', ability: 'Magic Guard', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Charm'] }), hpPercent: 100, active: true }],
        opp: [{ entry: oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] })), hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'debuff', target: 0 } as const]]), new Map(),
    );
    expect(out.opp[0]!.boosts.atk).toBe(-2);
  });

  test('debuff is offered as an action class', () => {
    const r = searchToDepth({
      mine: [{ set: mon({ species: 'Clefable', ability: 'Magic Guard', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Charm', 'Moonblast'] }), hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 1);
    expect(r.explored!.actionClasses).toContain('debuff');
  });
});

describe('pivot moves (U-turn / Parting Shot)', () => {
  test('U-turn chips the foe and the user switches out (bench takes the incoming hit)', () => {
    const out = resolveOneTurn(
      {
        mine: [
          { set: mon({ species: 'Flutter Mane', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['U-turn'] }), hpPercent: 100, active: true },
          { set: mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] }), hpPercent: 100, active: false },
        ],
        opp: [{ entry: oppOf(mon({ species: 'Incineroar', ability: 'Blaze', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Knock Off'] })), hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'pivot', target: 0 } as const]]), new Map([[0, { kind: 'attack', target: 0 } as const]]),
    );
    expect(out.opp[0]!.hpPct).toBeLessThan(100);    // U-turn chipped Incineroar
    expect(out.mine[0]!.hpPct).toBe(100);           // Flutter Mane pivoted out → safe from the hit
    expect(out.mine[1]!.hpPct).toBeLessThan(100);   // Dondozo came in and took the Knock Off
  });

  test('Parting Shot lowers the foe Atk and SpA as the user pivots out', () => {
    const out = resolveOneTurn(
      {
        mine: [
          { set: mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Parting Shot'] }), hpPercent: 100, active: true },
          { set: mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] }), hpPercent: 100, active: false },
        ],
        opp: [{ entry: oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] })), hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'pivot', target: 0 } as const]]), new Map(),
    );
    expect(out.opp[0]!.boosts.atk).toBe(-1);
    expect(out.opp[0]!.boosts.spa).toBe(-1);
  });

  test('pivot is offered as an action class when the side has a bench', () => {
    const r = searchToDepth({
      mine: [
        { set: mon({ species: 'Flutter Mane', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['U-turn', 'Moonblast'] }), hpPercent: 100, active: true },
        { set: mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] }), hpPercent: 100, active: false },
      ],
      opp: [{ entry: oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 1);
    expect(r.explored!.actionClasses).toContain('pivot');
  });
});

describe('priority moves (Bullet Punch / Sucker Punch / Aqua Jet …)', () => {
  test('a slow mon’s priority move strikes first and KOs before the faster foe acts', () => {
    const scizor = mon({ species: 'Scizor', ability: 'Technician', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Bullet Punch', 'U-turn'] });
    const out = resolveOneTurn(
      {
        mine: [{ set: scizor, hpPercent: 100, active: true }],
        opp: [{ entry: oppOf(mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] })), hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'prio', target: 0 } as const]]),    // Scizor: Bullet Punch (+1), though it's slower
      new Map([[0, { kind: 'attack', target: 0 } as const]]),  // Flutter Mane: Moonblast (faster, 0 priority)
    );
    expect(out.opp[0]!.fainted).toBe(true);     // Bullet Punch (Technician, SE vs Fairy) OHKOs
    expect(out.mine[0]!.hpPct).toBe(100);       // foe fainted before it could act → Scizor untouched
  });

  test('Sucker Punch (the priority cell) whiffs when the target isn’t attacking', () => {
    const kingambit = (): OpponentEntry => ({
      species: 'Kingambit', knownMoves: ['Sucker Punch', 'Kowtow Cleave'],
      candidates: [mon({ species: 'Kingambit', ability: 'Defiant', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Sucker Punch', 'Kowtow Cleave'] })],
    });
    // Garchomp knows a status move so the 'status' action is a real non-attack.
    const garc = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake', 'Thunder Wave'] });
    const base = {
      mine: [{ set: garc, hpPercent: 100, active: true }],
      opp: [{ entry: kingambit(), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    // Garchomp goes for Thunder Wave (status) → not attacking → Sucker Punch fails.
    const whiff = resolveOneTurn(base, new Map([[0, { kind: 'status', target: 0 } as const]]), new Map([[0, { kind: 'prio', target: 0 } as const]]));
    expect(whiff.mine[0]!.hpPct).toBe(100);
    // Garchomp attacks → Sucker Punch connects first (priority).
    const land = resolveOneTurn(base, new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map([[0, { kind: 'prio', target: 0 } as const]]));
    expect(land.mine[0]!.hpPct).toBeLessThan(100);
  });

  test('priority is offered as an action class when a priority move can KO', () => {
    const r = searchToDepth({
      mine: [{ set: mon({ species: 'Scizor', ability: 'Technician', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Bullet Punch', 'Close Combat'] }), hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 1);
    expect(r.explored!.actionClasses).toContain('priority');
  });

  test('Grassy Glide gains +1 priority in Grassy Terrain and moves first', () => {
    const rillaboom = mon({ species: 'Rillaboom', ability: 'Grassy Surge', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Grassy Glide', 'Wood Hammer'] });
    // Flutter Mane (Spe 135) outspeeds Rillaboom (Spe 85) on raw speed; at 25% a
    // Grassy-Glide chip KOs it — but only if Rillaboom moves FIRST via terrain priority.
    const out = resolveOneTurn(
      { mine: [{ set: rillaboom, hpPercent: 100, active: true }], opp: [{ entry: oppOf(mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] })), hpPercent: 25, active: true }], field: { ...NEUTRAL_FIELD, terrain: 'Grassy' }, allOppRevealed: true },
      new Map([[0, { kind: 'prio', target: 0 } as const]]), new Map([[0, { kind: 'attack', target: 0 } as const]]),
    );
    expect(out.opp[0]!.fainted).toBe(true);   // Grassy Glide KOs the weakened foe
    expect(out.mine[0]!.hpPct).toBe(100);     // moved first via terrain priority → Flutter Mane never acted
  });

  test('Triage gives a draining move +3 priority (Comfey Draining Kiss moves first)', () => {
    const comfey = mon({ species: 'Comfey', ability: 'Triage', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Draining Kiss'] });
    const out = resolveOneTurn(
      { mine: [{ set: comfey, hpPercent: 100, active: true }], opp: [{ entry: oppOf(mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake'] })), hpPercent: 20, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map([[0, { kind: 'prio', target: 0 } as const]]), new Map([[0, { kind: 'attack', target: 0 } as const]]),
    );
    expect(out.opp[0]!.fainted).toBe(true);   // Draining Kiss (SE vs Dragon) KOs the weakened Garchomp
    expect(out.mine[0]!.hpPct).toBe(100);     // Triage +3 → Comfey moved before the faster Garchomp
  });

  test('Grassy Glide is a priority option ONLY in Grassy Terrain', () => {
    const classes = (terrain: 'Grassy' | null) => searchToDepth({
      mine: [{ set: mon({ species: 'Rillaboom', ability: 'Grassy Surge', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Grassy Glide', 'Wood Hammer'] }), hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] })), hpPercent: 20, active: true }],
      field: { ...NEUTRAL_FIELD, terrain }, allOppRevealed: true,
    }, 1).explored!.actionClasses;
    expect(classes('Grassy')).toContain('priority');
    expect(classes(null)).not.toContain('priority');
  });
});

describe('Helping Hand (doubles support)', () => {
  const base = () => ({
    mine: [
      { set: mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Helping Hand', 'Fake Out'] }), hpPercent: 100, active: true },
      { set: mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] }), hpPercent: 100, active: true },
    ],
    opp: [{ entry: oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] })), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  });

  test('boosts the ally’s damage ×1.5', () => {
    const without = resolveOneTurn(base(), new Map([[1, { kind: 'attack', target: 0 } as const]]), new Map());
    const withHH = resolveOneTurn(base(), new Map([[0, { kind: 'helpinghand' } as const], [1, { kind: 'attack', target: 0 } as const]]), new Map());
    const dmgWithout = 100 - without.opp[0]!.hpPct;
    const dmgWith = 100 - withHH.opp[0]!.hpPct;
    expect(dmgWithout).toBeGreaterThan(0);
    expect(dmgWith / dmgWithout).toBeCloseTo(1.5, 1);
  });

  test('helpinghand is an action class when a knower has a live ally', () => {
    const r = searchToDepth(base(), 1);
    expect(r.explored!.actionClasses).toContain('helpinghand');
  });

  test('not offered with no live ally (single active)', () => {
    const solo = base();
    solo.mine = [solo.mine[0]!];   // only the Helping Hand user, no partner
    const r = searchToDepth(solo, 1);
    expect(r.explored!.actionClasses).not.toContain('helpinghand');
  });
});

describe('Wide Guard / Quick Guard (team protect)', () => {
  test('Wide Guard blocks the opponent’s spread move for the whole side', () => {
    const out = resolveOneTurn(
      {
        mine: [
          { set: mon({ species: 'Hitmontop', ability: 'Intimidate', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wide Guard', 'Fake Out'] }), hpPercent: 100, active: true },
          { set: mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] }), hpPercent: 100, active: true },
        ],
        opp: [{ entry: oppOf(mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Earthquake'] })), hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'wideguard' } as const]]),
      new Map([[0, { kind: 'spread' } as const]]),
    );
    expect(out.mine[0]!.hpPct).toBe(100);   // Hitmontop protected
    expect(out.mine[1]!.hpPct).toBe(100);   // Flutter Mane protected too — Wide Guard is side-wide
  });

  test('Quick Guard blocks the opponent’s priority move', () => {
    const out = resolveOneTurn(
      {
        mine: [
          { set: mon({ species: 'Hitmontop', ability: 'Intimidate', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Quick Guard'] }), hpPercent: 100, active: true },
          { set: mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] }), hpPercent: 100, active: true },
        ],
        opp: [{ entry: { species: 'Kingambit', knownMoves: ['Sucker Punch'], candidates: [mon({ species: 'Kingambit', ability: 'Defiant', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Sucker Punch'] })] }, hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      // Flutter Mane attacks (so Sucker Punch wouldn't whiff on the fail condition);
      // Hitmontop's Quick Guard is what blocks the priority KO.
      new Map([[0, { kind: 'quickguard' } as const], [1, { kind: 'attack', target: 0 } as const]]),
      new Map([[0, { kind: 'prio', target: 1 } as const]]),
    );
    expect(out.mine[1]!.hpPct).toBe(100);   // Sucker Punch (SE vs Flutter Mane) blocked by Quick Guard
  });
});

describe('Strength Sap + Protect-variant punishes', () => {
  test('Strength Sap heals the user and drops the foe’s Attack', () => {
    const out = resolveOneTurn(
      {
        mine: [{ set: mon({ species: 'Sinistcha', ability: 'Hospitality', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Strength Sap', 'Matcha Gotcha'] }), hpPercent: 40, active: true }],
        opp: [{ entry: oppOf(mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Earthquake'] })), hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'strengthsap' } as const]]), new Map(),
    );
    expect(out.mine[0]!.hpPct).toBeGreaterThan(40);   // healed by Garchomp's (high) Attack stat
    expect(out.opp[0]!.boosts.atk).toBe(-1);          // and Garchomp's Attack dropped
  });

  test('King’s Shield drops a contacting attacker’s Attack', () => {
    const out = resolveOneTurn(
      {
        mine: [{ set: mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Dragon Claw'] }), hpPercent: 100, active: true }],
        opp: [{ entry: { species: 'Aegislash', knownMoves: ["King's Shield"], candidates: [mon({ species: 'Aegislash', ability: 'Stance Change', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ["King's Shield", 'Shadow Ball'] })] }, hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'attack', target: 0 } as const]]),   // Dragon Claw (contact) into the shield
      new Map([[0, { kind: 'protect' } as const]]),             // Aegislash uses King's Shield
    );
    expect(out.mine[0]!.boosts.atk).toBe(-1);
  });

  test('Explosion faints the user after dealing damage', () => {
    const out = resolveOneTurn(
      {
        mine: [{ set: mon({ species: 'Gengar', ability: 'Cursed Body', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Explosion'] }), hpPercent: 100, active: true }],
        opp: [{ entry: oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] })), hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map(),
    );
    expect(out.mine[0]!.fainted).toBe(true);   // Explosion → the user faints
    expect(out.opp[0]!.hpPct).toBeLessThan(100);
  });

  test('Weakness Policy → +2 Atk/+2 SpA on a surviving super-effective hit', () => {
    const out = resolveOneTurn(
      {
        mine: [{ set: mon({ species: 'Garchomp', item: 'Weakness Policy', ability: 'Rough Skin', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Earthquake'] }), hpPercent: 100, active: true }],
        opp: [{ entry: oppOf(mon({ species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', evs: { ...ZERO_EVS, spe: 252 }, moves: ['Moonblast'] })), hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map(), new Map([[0, { kind: 'attack', target: 0 } as const]]),   // Moonblast (Fairy) is SE on Garchomp
    );
    expect(out.mine[0]!.fainted).toBe(false);   // survived
    expect(out.mine[0]!.boosts.atk).toBe(2);
    expect(out.mine[0]!.boosts.spa).toBe(2);
  });

  test('Weakness Policy does NOT proc on a neutral hit', () => {
    const out = resolveOneTurn(
      {
        mine: [{ set: mon({ species: 'Garchomp', item: 'Weakness Policy', ability: 'Rough Skin', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Earthquake'] }), hpPercent: 100, active: true }],
        opp: [{ entry: oppOf(mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Knock Off'] })), hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map(), new Map([[0, { kind: 'attack', target: 0 } as const]]),   // Knock Off (Dark) neutral on Garchomp
    );
    expect(out.mine[0]!.boosts.atk ?? 0).toBe(0);
  });

  test('Spiky Shield chips a contacting attacker', () => {
    const out = resolveOneTurn(
      {
        mine: [{ set: mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Dragon Claw'] }), hpPercent: 100, active: true }],
        opp: [{ entry: { species: 'Decidueye', knownMoves: ['Spiky Shield'], candidates: [mon({ species: 'Decidueye', ability: 'Overgrow', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Spiky Shield', 'Leaf Blade'] })] }, hpPercent: 100, active: true }],
        field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
      },
      new Map([[0, { kind: 'attack', target: 0 } as const]]),
      new Map([[0, { kind: 'protect' } as const]]),
    );
    expect(out.mine[0]!.hpPct).toBeLessThan(100);   // 1/8 Spiky Shield chip
  });
});

describe('hazard clearing (Rapid Spin / Defog)', () => {
  const base = (myHazards?: { rocks?: boolean; spikes?: 0 | 1 | 2 | 3 }) => ({
    mine: [{ set: mon({ species: 'Great Tusk', ability: 'Protosynthesis', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Rapid Spin', 'Headlong Rush'] }), hpPercent: 100, active: true }],
    opp: [{ entry: oppOf(mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake'] })), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD, ...(myHazards ? { myHazards } : {}) }, allOppRevealed: true,
  });

  test('Rapid Spin is offered as an action class only when own side has hazards', () => {
    expect(searchToDepth(base({ rocks: true }), 1).explored!.actionClasses).toContain('hazardclear');
    expect(searchToDepth(base(), 1).explored!.actionClasses).not.toContain('hazardclear');
  });
});

describe('on-KO boosts (Moxie / Beast Boost)', () => {
  // A frail foe at 12% HP is KO'd by any hit → the attacker's on-KO ability fires.
  const koFrailFoe = (set: PokemonSet) => resolveOneTurn(
    { mine: [{ set, hpPercent: 100, active: true }], opp: [{ entry: oppOf(mon({ species: 'Flutter Mane', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'] })), hpPercent: 12, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
    new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map(),
  ).mine[0]!.boosts;

  test('Moxie gives +1 Atk on a KO', () => {
    expect(koFrailFoe(mon({ species: 'Gyarados', ability: 'Moxie', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Waterfall'] })).atk).toBe(1);
  });
  test('Beast Boost raises the highest stat (Kartana → Atk)', () => {
    expect(koFrailFoe(mon({ species: 'Kartana', ability: 'Beast Boost', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Leaf Blade'] })).atk).toBe(1);
  });
  test('no boost without the ability', () => {
    expect(koFrailFoe(mon({ species: 'Gyarados', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Waterfall'] })).atk ?? 0).toBe(0);
  });
});

describe('Life Orb recoil', () => {
  const wall = (): OpponentEntry => oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] }));
  const hpAfter = (item: string, ability = 'Sand Stream') => resolveOneTurn(
    { mine: [{ set: mon({ species: 'Tyranitar', item, ability, nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Crunch'] }), hpPercent: 100, active: true }], opp: [{ entry: wall(), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
    new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map(),
  ).mine[0]!.hpPct;

  test('a Life Orb holder loses 10% on a damaging hit', () => {
    expect(hpAfter('Life Orb')).toBe(90);
  });
  test('no Life Orb → no chip', () => {
    expect(hpAfter('Leftovers')).toBeGreaterThanOrEqual(100);   // (Leftovers heals, but at full it stays 100)
  });
  test('Magic Guard negates Life Orb recoil', () => {
    expect(hpAfter('Life Orb', 'Magic Guard')).toBe(100);
  });
});

describe('recoil moves (Brave Bird / Rock Head)', () => {
  const wall = (): OpponentEntry => oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] }));
  const hpAfter = (ability: string) => resolveOneTurn(
    { mine: [{ set: mon({ species: 'Talonflame', ability, nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Brave Bird'] }), hpPercent: 100, active: true }], opp: [{ entry: wall(), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
    new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map(),
  ).mine[0]!.hpPct;

  test('Brave Bird recoils the attacker', () => {
    expect(hpAfter('Flame Body')).toBeLessThan(100);     // took recoil
  });
  test('Rock Head negates recoil', () => {
    expect(hpAfter('Rock Head')).toBe(100);              // no recoil
  });
});

describe('foe stat-drops + Defiant / Competitive', () => {
  const wall = (over: Partial<PokemonSet> = {}): OpponentEntry => oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'], ...over }));

  // Low Sweep's 100% -1 Spe secondary lands on the target (speed control).
  test('Low Sweep drops the target Spe -1', () => {
    const me = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Low Sweep'] });
    const out = resolveOneTurn({ mine: [{ set: me, hpPercent: 100, active: true }], opp: [{ entry: wall(), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map());
    expect(out.opp[0]!.boosts.spe).toBe(-1);
  });

  // Snarl's 100% -1 SpA spread secondary lands on every foe hit.
  test('Snarl (spread) drops the foe SpA -1', () => {
    const me = mon({ species: 'Incineroar', ability: 'Blaze', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Snarl'] });
    const out = resolveOneTurn({ mine: [{ set: me, hpPercent: 100, active: true }], opp: [{ entry: wall(), hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map([[0, { kind: 'spread' } as const]]), new Map());
    expect(out.opp[0]!.boosts.spa).toBe(-1);
  });

  // Defiant reacts to an opponent-caused drop with +2 Atk (net here: SpA -1, Atk +2).
  test('Defiant reacts +2 Atk to a foe stat-drop', () => {
    const kingambit = mon({ species: 'Kingambit', ability: 'Defiant', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Iron Head'] });
    const snarler: OpponentEntry = oppOf(mon({ species: 'Incineroar', ability: 'Blaze', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Snarl'] }));
    const out = resolveOneTurn({ mine: [{ set: kingambit, hpPercent: 100, active: true }], opp: [{ entry: snarler, hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map([[0, { kind: 'spread' } as const]]));
    expect(out.mine[0]!.boosts.spa).toBe(-1);
    expect(out.mine[0]!.boosts.atk).toBe(2);
  });

  // Clear Body blocks the drop entirely (and so no Defiant-style reaction).
  test('Clear Body blocks the foe stat-drop', () => {
    const metagross = mon({ species: 'Metagross', ability: 'Clear Body', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Iron Head'] });
    const snarler: OpponentEntry = oppOf(mon({ species: 'Incineroar', ability: 'Blaze', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Snarl'] }));
    const out = resolveOneTurn({ mine: [{ set: metagross, hpPercent: 100, active: true }], opp: [{ entry: snarler, hpPercent: 100, active: true }], field: { ...NEUTRAL_FIELD }, allOppRevealed: true },
      new Map([[0, { kind: 'attack', target: 0 } as const]]), new Map([[0, { kind: 'spread' } as const]]));
    expect(out.mine[0]!.boosts.spa ?? 0).toBe(0);
  });
});

describe('unmodeled-mechanics detector (self-flagging)', () => {
  // A clean position (only standard attacks) carries NO unmodeled warning.
  test('fully-modelled position reports nothing', () => {
    const r = searchToDepth({
      mine: [{ set: mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake', 'Dragon Claw'] }), hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 1);
    expect(r.unmodeled).toBeUndefined();
  });

  // A still-unmodelled mechanic (two-turn Solar Beam) is flagged with the source.
  test('flags a two-turn move from my own moveset with a concrete example', () => {
    const r = searchToDepth({
      mine: [{ set: mon({ species: 'Lilligant', ability: 'Chlorophyll', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Solar Beam', 'Giga Drain'] }), hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 1);
    const twoturn = r.unmodeled?.find(u => u.kind === 'twoturn');
    expect(twoturn).toBeDefined();
    expect(twoturn!.examples).toContain('Lilligant Solar Beam');
  });

  // Opponent scan is REVEALED-only: an unseen Icy Wind isn't warned about, a
  // revealed one is.
  test('opponent stat-drop flagged only once revealed (opp-conservatism)', () => {
    const hidden = oppOf(mon({ species: 'Pelipper', ability: 'Drizzle', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Hurricane'] }));
    const make = (knownMoves: string[]): SearchInput => ({
      mine: [{ set: mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake'] }), hpPercent: 100, active: true }],
      opp: [{ entry: { ...hidden, knownMoves }, hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    expect(searchToDepth(make(['Hurricane']), 1).unmodeled?.some(u => u.kind === 'foedebuff')).toBeFalsy();
    expect(searchToDepth(make(['Growl']), 1).unmodeled?.some(u => u.kind === 'foedebuff')).toBe(true);
  });
});

describe('P2: hazard setting (Stone Axe + dedicated moves + refill chip)', () => {
  // The frail opp active is OHKO'd; the opponent refills its (revealed) bench. A
  // replacement entering AFTER a faint now eats the Stealth Rock chip — so the
  // same board scores better for me when their side already has rocks up.
  test('existing Stealth Rock chips the opponent refill-in after a KO', () => {
    const make = (rocks: boolean): SearchInput => ({
      mine: [{ set: mon({ species: 'Iron Bundle', ability: 'Quark Drive', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Hydro Pump'] }), hpPercent: 100, active: true }],
      opp: [
        { entry: oppOf(mon({ species: 'Vulpix', nature: 'Timid', evs: { ...ZERO_EVS, spa: 4, spe: 4 }, moves: ['Ember'] })), hpPercent: 100, active: true },
        { entry: oppOf(mon({ species: 'Talonflame', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Brave Bird'] })), hpPercent: 100, active: false },
      ],
      field: { ...NEUTRAL_FIELD, theirHazards: rocks ? { rocks: true } : undefined }, allOppRevealed: true,
    });
    // Talonflame is 4× weak to Rock, so the refill SR chip is large → my score
    // higher. Depth 1 so the opp isn't wiped (a WIN terminal would mask the HP).
    expect(searchToDepth(make(true), 1).score).toBeGreaterThan(searchToDepth(make(false), 1).score);
  });

  // Stone Axe SETS Stealth Rock on the foe's side as it hits (a damaging-move
  // secondary), feeding the SAME oppHazards path the existing-rocks refill test
  // exercises. It's modelled as a normal ATTACK (not the dedicated hazard class)
  // and the search stays stable with the hazard plumbing live. (A freshly-set
  // hazard is correctly dodgeable in a short horizon — a rational opp pre-switches
  // before the rock lands — so its in-search payoff is the FORCED-refill case the
  // existing-rocks test covers, not a single-turn score swing here.)
  test('Stone Axe is handled as an attack with hazard-setting live (stable, recommended)', () => {
    const r = searchToDepth({
      mine: [{ set: mon({ species: 'Kleavor', ability: 'Sharpness', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Stone Axe'] }), hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(mon({ species: 'Vulpix', nature: 'Timid', evs: { ...ZERO_EVS, spa: 4, spe: 4 }, moves: ['Ember'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    expect(r.plays.map(p => p.move)).toContain('Stone Axe');   // recommended, not crashed
    expect(r.verdict).toBe('winning');                          // OHKO line still found
    expect(r.explored!.actionClasses).not.toContain('hazard');  // it's an attack, not a dedicated setter
  });

  // A dedicated Stealth Rock move is offered as an action (breadth chip lists it).
  test('a Stealth Rock user surfaces the hazard action class', () => {
    const withRocks = searchToDepth({
      mine: [{ set: mon({ species: 'Tyranitar', ability: 'Sand Stream', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Stealth Rock', 'Rock Slide'] }), hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 1);
    expect(withRocks.explored!.actionClasses).toContain('hazard');
  });

  // Rocks already up on the foe's side → no point re-setting → no hazard class.
  test('no hazard class when the layer is already maxed on the foe side', () => {
    const r = searchToDepth({
      mine: [{ set: mon({ species: 'Tyranitar', ability: 'Sand Stream', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Stealth Rock', 'Rock Slide'] }), hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] })), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD, theirHazards: { rocks: true } }, allOppRevealed: true,
    }, 1);
    expect(r.explored!.actionClasses).not.toContain('hazard');
  });
});
