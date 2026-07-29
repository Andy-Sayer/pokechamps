// A perish trap killed two mons in live play (2026-07-28) and the app said nothing.
// The search itself was fine — given the clock it values the position as losing and
// picks the escape. What was missing was the clock (vision had no grammar for the
// counter banners) and any EXPLANATION of what to do about it.
import { describe, test, expect } from 'vitest';
import { analyzePerishTrap, type PerishSide } from '../src/domain/perishTrap.js';

const mon = (p: Partial<PerishSide> & { species: string }): PerishSide =>
  ({ moves: [], active: true, hpPercent: 100, ...p });

const gengar = mon({ species: 'Gengar', item: 'Focus Sash', moves: ['Perish Song', 'Shadow Ball'] });
const meanLooker = mon({ species: 'Blastoise', moves: ['Mean Look', 'Surf'] });

describe('perish trap — ACTIVE (clock running)', () => {
  const trappedChomp = mon({ species: 'Garchomp', moves: ['Earthquake', 'U-turn'], perishCount: 2, trappedByFoe: 1 });

  test('names the victim, the clock and the trapper', () => {
    const a = analyzePerishTrap([trappedChomp], [gengar, meanLooker])!;
    expect(a.phase).toBe('active');
    expect(a.turnsLeft).toBe(2);
    expect(a.victims).toEqual(['Garchomp']);
    expect(a.trapper).toBe('Blastoise');
    expect(a.headline).toContain('PERISH TRAP');
  });

  test('the pivot escape is offered and marked as saving the mon', () => {
    const a = analyzePerishTrap([trappedChomp], [gengar, meanLooker])!;
    const pivot = a.outs.find(o => o.kind === 'pivot' && o.saves);
    expect(pivot?.label).toContain('U-turn');
  });

  test('BATON PASS is called out as NOT an escape — it hands the count on', () => {
    // The subtle one: it bypasses trapping like any pivot, but resolveTurn passes the
    // perish count to the incoming mon, so it trades one dead mon for another.
    const bp = mon({ species: 'Garchomp', moves: ['Earthquake', 'Baton Pass'], perishCount: 2, trappedByFoe: 1 });
    const a = analyzePerishTrap([bp], [gengar, meanLooker])!;
    const warn = a.outs.find(o => o.label.includes('Baton Pass'));
    expect(warn).toBeDefined();
    expect(warn!.saves).toBe(false);
  });

  test('KOing the trapper frees the switch — but not when the clock beats it', () => {
    const soon = mon({ species: 'Garchomp', moves: ['Earthquake'], perishCount: 1, trappedByFoe: 1 });
    const inTime = analyzePerishTrap([trappedChomp], [gengar, meanLooker])!;
    const tooLate = analyzePerishTrap([soon], [gengar, meanLooker])!;
    expect(inTime.outs.find(o => o.kind === 'ko-trapper')!.saves).toBe(true);
    expect(tooLate.outs.find(o => o.kind === 'ko-trapper')!.saves).toBe(false);
    expect(tooLate.outs.find(o => o.kind === 'ko-trapper')!.label).toContain('too late');
  });

  test('an untrapped partner is told to switch and clear its own count', () => {
    const partner = mon({ species: 'Dragonite', moves: ['Extreme Speed'], perishCount: 2 });
    const a = analyzePerishTrap([trappedChomp, partner], [gengar, meanLooker])!;
    expect(a.outs.some(o => o.kind === 'partner-switch' && o.label.includes('Dragonite'))).toBe(true);
  });

  test('a GHOST on the clock is not trapped at all', () => {
    const ghost = mon({ species: 'Dragapult', moves: ['Dragon Darts'], perishCount: 2, trappedByFoe: 1 });
    const a = analyzePerishTrap([ghost], [gengar, meanLooker])!;
    expect(a.headline).not.toContain('cannot leave');
    expect(a.victims).toEqual(['Dragapult']);
  });

  test('Shed Shell likewise walks away', () => {
    const shed = mon({ species: 'Garchomp', item: 'Shed Shell', moves: ['Earthquake'], perishCount: 2, trappedByFoe: 1 });
    const a = analyzePerishTrap([shed], [gengar, meanLooker])!;
    expect(a.headline).toContain('switch to clear it');
  });
});

describe('perish trap — ARMED (pieces on the field, no song yet)', () => {
  test('warns before the song lands and names both pieces', () => {
    const me = mon({ species: 'Garchomp', moves: ['Earthquake'] });
    const a = analyzePerishTrap([me], [gengar, meanLooker])!;
    expect(a.phase).toBe('armed');
    expect(a.singer).toBe('Gengar');
    expect(a.trapper).toBe('Blastoise');
    expect(a.outs.some(o => o.kind === 'ko-trapper')).toBe(true);
  });

  test('Taunt is offered as the denial', () => {
    const taunter = mon({ species: 'Whimsicott', ability: 'Prankster', moves: ['Taunt', 'Moonblast'] });
    const a = analyzePerishTrap([taunter], [gengar, meanLooker])!;
    expect(a.outs.some(o => o.kind === 'taunt-singer' && o.label.includes('Taunt'))).toBe(true);
  });

  test('Soundproof is recognised as immunity', () => {
    const proof = mon({ species: 'Bouffalant', ability: 'Soundproof', moves: ['Head Charge'] });
    const a = analyzePerishTrap([proof], [gengar, meanLooker])!;
    expect(a.outs.some(o => o.kind === 'soundproof')).toBe(true);
  });

  test('a singer with NO trapper is not a trap — stay quiet', () => {
    const loneSinger = mon({ species: 'Gengar', moves: ['Perish Song'] });
    const plainFoe = mon({ species: 'Milotic', moves: ['Scald'] });
    expect(analyzePerishTrap([mon({ species: 'Garchomp', moves: ['Earthquake'] })], [loneSinger, plainFoe])).toBeNull();
  });

  test('no song anywhere → nothing to say', () => {
    expect(analyzePerishTrap([mon({ species: 'Garchomp', moves: ['Earthquake'] })], [meanLooker])).toBeNull();
  });
});

// End-to-end: the advisory must ride on the SearchResult, independent of depth. This is
// the property that matters — a perish trap kills three turns out, past the horizon a
// live search reaches on a wide board, so the verdict can read fine right up until two
// mons die. Depth-1 and depth-2 must both carry the warning.
describe('perish advice rides the SearchResult at any depth', () => {
  test('depth 1 and depth 2 both carry it', async () => {
    const { searchToDepth } = await import('../src/domain/endgameSearch.js');
    const { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } = await import('../src/domain/types.js');
    const set = (species: string, moves: string[], ability?: string) =>
      ({ species, ability, moves, level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS });
    const oppOf = (s: ReturnType<typeof set>) => ({ species: s.species, knownMoves: s.moves, ability: s.ability, candidates: [s] });
    const input = {
      mine: [
        { set: set('Garchomp', ['Earthquake', 'U-turn']), hpPercent: 100, active: true, perishCount: 2, trappedByFoe: 1 },
        { set: set('Dragonite', ['Extreme Speed']), hpPercent: 100, active: true, perishCount: 2 },
        { set: set('Kingambit', ['Iron Head']), hpPercent: 100, active: false },
      ],
      opp: [
        { entry: oppOf(set('Gengar', ['Perish Song', 'Shadow Ball'])), hpPercent: 100, active: true, perishCount: 2 },
        { entry: oppOf(set('Blastoise', ['Mean Look', 'Surf'])), hpPercent: 100, active: true, perishCount: 2 },
        { entry: oppOf(set('Milotic', ['Scald'])), hpPercent: 100, active: false },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    } as never;
    for (const depth of [1, 2]) {
      const r = searchToDepth(input, depth);
      expect(r.perishTrap, `depth ${depth}`).toBeDefined();
      expect(r.perishTrap!.phase).toBe('active');
      expect(r.perishTrap!.turnsLeft).toBe(2);
      expect(r.perishTrap!.outs.some(o => o.label.includes('U-turn'))).toBe(true);
    }
  }, 30000);
});

// CHOICE LOCK. Caught by the user on the first version: a Choice-Scarf Garchomp locked
// into Earthquake cannot click U-turn, so offering it is ILLEGAL advice — worse than
// silence, because it sends the player looking for an escape that isn't there.
describe('perish trap respects the Choice lock', () => {
  const gengar2 = mon({ species: 'Gengar', item: 'Focus Sash', moves: ['Perish Song', 'Shadow Ball'] });
  const looker = mon({ species: 'Blastoise', moves: ['Mean Look', 'Surf'] });

  test('a mon LOCKED into a non-pivot is never told to pivot', () => {
    const locked = mon({
      species: 'Garchomp', item: 'Choice Scarf', moves: ['Earthquake', 'U-turn'],
      perishCount: 2, trappedByFoe: 1, choiceLockedMove: 'Earthquake',
    });
    const a = analyzePerishTrap([locked], [gengar2, looker])!;
    expect(a.outs.some(o => o.kind === 'pivot' && o.saves)).toBe(false);
    expect(a.outs.some(o => o.label.includes('Choice-locked into Earthquake'))).toBe(true);
  });

  test('…and the headline names the only remaining out: KO the trapper', () => {
    // Breaking a MOVE-trap by KO genuinely frees the switch, so this isn't "no escape" —
    // but it IS conditional on damage this layer can't promise, so it must not be
    // dressed up as a certain one.
    const locked = mon({
      species: 'Garchomp', item: 'Choice Scarf', moves: ['Earthquake', 'U-turn'],
      perishCount: 2, trappedByFoe: 1, choiceLockedMove: 'Earthquake',
    });
    const a = analyzePerishTrap([locked], [gengar2, looker])!;
    expect(a.headline).toContain('only out: KO Blastoise');
    expect(a.outs.some(o => o.kind === 'ko-trapper' && o.saves)).toBe(true);
  });

  test('with the trapper already gone and no pivot, it says NO ESCAPE outright', () => {
    // Ability-trapped by a mon that can't be removed from the equation: Shadow Tag.
    const shadowTagger = mon({ species: 'Gothitelle', ability: 'Shadow Tag', moves: ['Psychic'] });
    const singer2 = mon({ species: 'Gengar', moves: ['Perish Song'] });
    const locked = mon({
      species: 'Garchomp', item: 'Choice Scarf', moves: ['Dragon Claw'],
      perishCount: 1, trappedByFoe: null, choiceLockedMove: 'Dragon Claw',
    });
    const a = analyzePerishTrap([locked], [singer2, shadowTagger])!;
    // perish 1 → the KO comes too late to matter, so nothing saves it.
    expect(a.headline).toContain('NO ESCAPE');
    expect(a.outs[0]!.label).toContain('CANNOT escape');
  });

  test('locked INTO the pivot — that still works', () => {
    const lockedIntoPivot = mon({
      species: 'Garchomp', item: 'Choice Scarf', moves: ['Earthquake', 'U-turn'],
      perishCount: 2, trappedByFoe: 1, choiceLockedMove: 'U-turn',
    });
    const a = analyzePerishTrap([lockedIntoPivot], [gengar2, looker])!;
    expect(a.outs.some(o => o.kind === 'pivot' && o.saves && o.label.includes('U-turn'))).toBe(true);
  });

  test('holding a Choice item but NOT yet locked → warn to click the pivot first', () => {
    const unlocked = mon({
      species: 'Garchomp', item: 'Choice Scarf', moves: ['Earthquake', 'U-turn'],
      perishCount: 2, trappedByFoe: 1,
    });
    const a = analyzePerishTrap([unlocked], [gengar2, looker])!;
    const pivot = a.outs.find(o => o.kind === 'pivot' && o.saves)!;
    expect(pivot.label).toContain('click it FIRST');
  });

  test('no pivot at all, no lock: still NO ESCAPE, and the partner is still rescued', () => {
    const plain = mon({ species: 'Garchomp', moves: ['Earthquake', 'Dragon Claw'], perishCount: 2, trappedByFoe: 1 });
    const partner = mon({ species: 'Dragonite', moves: ['Extreme Speed'], perishCount: 2 });
    const a = analyzePerishTrap([plain, partner], [gengar2, looker])!;
    expect(a.headline).toContain('only out: KO Blastoise');
    expect(a.outs.some(o => o.kind === 'partner-switch')).toBe(true);
  });
});

// THE REAL BOARD (live, 2026-07-28). Reported by the user after the first version told
// them to KO the trapper: "KO Blastoise was how Gengar managed to switch back in and keep
// me trapped." Mega Gengar's ability is SHADOW TAG, so Gengar is the singer AND the real
// trapper; Blastoise was a body. KOing it opened the slot for Gengar to return and
// re-apply the tag — the advice actively helped the opponent.
describe('a KO opens a slot the OPPONENT fills', () => {
  test('a Gengarite Gengar is recognised as a trapper BEFORE it megas', () => {
    // Base ability is Cursed Body; reading only that hides Shadow Tag until too late.
    const gengar = mon({ species: 'Gengar', ability: 'Cursed Body', item: 'Gengarite', moves: ['Perish Song', 'Shadow Ball'] });
    const chomp = mon({ species: 'Garchomp', moves: ['Earthquake'] });
    const a = analyzePerishTrap([chomp], [gengar, mon({ species: 'Blastoise', moves: ['Surf'] })])!;
    expect(a.phase).toBe('armed');
    expect(a.trapper).toBe('Gengar');       // not "no trapper found"
    // One mon holds both halves of the combo, so removing it removes the whole trap.
    expect(a.headline).toContain('both sings and traps');
  });

  test('the spend-it line stops telling me to hit the trapper when that opens the slot', () => {
    const gengar = mon({ species: 'Gengar', ability: 'Cursed Body', item: 'Gengarite', moves: ['Perish Song'], active: false });
    const blastoise = mon({ species: 'Blastoise', moves: ['Mean Look', 'Surf'] });
    const chomp = mon({ species: 'Garchomp', item: 'Choice Scarf', choiceLockedMove: 'Earthquake',
      moves: ['Earthquake', 'U-turn'], perishCount: 2, trappedByFoe: 0 });
    const a = analyzePerishTrap([chomp], [blastoise, gengar])!;
    const spend = a.outs.find(o => o.label.includes('CANNOT escape'))!;
    expect(spend.label).not.toContain('hit the trapper');
    expect(spend.label).toContain('Gengar');
  });

  test('KOing the front trapper is NOT offered while another trapper can return', () => {
    const gengar = mon({ species: 'Gengar', ability: 'Cursed Body', item: 'Gengarite', moves: ['Perish Song'], active: false });
    const blastoise = mon({ species: 'Blastoise', moves: ['Mean Look', 'Surf'] });
    const chomp = mon({ species: 'Garchomp', moves: ['Earthquake'], perishCount: 2, trappedByFoe: 1 });
    // Board: Blastoise front (index 1 is the Mean Look holder), Gengar waiting on the bench.
    const filler = mon({ species: 'Milotic', moves: ['Scald'] });
    const a = analyzePerishTrap([chomp], [filler, blastoise, gengar])!;
    const ko = a.outs.find(o => o.kind === 'ko-trapper')!;
    expect(ko.saves).toBe(false);
    expect(ko.label).toContain('Do NOT bank on');
    expect(ko.label).toContain('Gengar');
  });

  test('an UNREVEALED Gengar downgrades the KO — the stone is the thing we cannot see', () => {
    // No item known, no Shadow Tag showing: nothing in the observed data says "trapper"
    // until the mega lands. That is precisely how the live game was lost.
    const gengar = mon({ species: 'Gengar', moves: ['Shadow Ball'], active: false });
    const blastoise = mon({ species: 'Blastoise', moves: ['Mean Look', 'Surf'] });
    const chomp = mon({ species: 'Garchomp', moves: ['Earthquake'], perishCount: 2, trappedByFoe: 0 });
    const a = analyzePerishTrap([chomp], [blastoise, gengar])!;
    const ko = a.outs.find(o => o.kind === 'ko-trapper')!;
    expect(ko.saves).toBe(false);
    expect(ko.label).toContain('can mega into a trapping ability');
  });

  test('with nobody left to re-trap, the KO IS the out', () => {
    const blastoise = mon({ species: 'Blastoise', moves: ['Mean Look', 'Surf'] });
    const milotic = mon({ species: 'Milotic', moves: ['Scald'], active: false });
    const chomp = mon({ species: 'Garchomp', moves: ['Earthquake'], perishCount: 2, trappedByFoe: 0 });
    const a = analyzePerishTrap([chomp], [blastoise, milotic])!;
    const ko = a.outs.find(o => o.kind === 'ko-trapper')!;
    expect(ko.saves).toBe(true);
    expect(ko.label).toContain('nothing left on their side re-traps');
  });
});
