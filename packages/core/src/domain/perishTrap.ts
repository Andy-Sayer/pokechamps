/**
 * perishTrap.ts — recognise a perish trap and name the way out.
 *
 * WHY THIS EXISTS (live, 2026-07-28): a perish trap killed two of my mons and the app
 * said nothing. The post-mortem found the search itself is fine — given the clock it
 * correctly values the position as losing and even picks the U-turn escape. What was
 * missing was, in order:
 *   1. the CLOCK (vision had no grammar for "X's perish count fell to N!", so the engine
 *      never knew a song had landed — fixed separately), and
 *   2. any EXPLANATION. "⌁ best play: U-turn" with no reason is easy to override when
 *      Earthquake looks better, and before the song lands there was no warning at all.
 *
 * The trap is a two-piece combo: a SINGER (Perish Song) plus a TRAPPER (Mean Look /
 * Block / Shadow Tag / Arena Trap …). The song hits everyone, but only the trapping side
 * can rotate — switching CLEARS your own count — so the trapped side runs out of clock
 * first. Every counter is therefore some way of restoring your ability to leave, or of
 * denying the song in the first place.
 *
 * The escape rules mirror endgameSearch exactly, including two that a plausible-sounding
 * summary gets wrong:
 *   • BATON PASS IS NOT AN ESCAPE. It bypasses trapping like other pivots, but it PASSES
 *     THE PERISH COUNT to the incoming mon (see the myBaton branch in resolveTurn), so
 *     recommending it trades one dead mon for a different dead mon.
 *   • A MOVE-trap only holds while its trapper is alive and on the field, so KOing the
 *     trapper genuinely frees the switch. An ABILITY-trap (Shadow Tag) needs the same
 *     KO but can't be escaped by outliving the volatile.
 */
import { getMove, getSpecies, toId } from './data.js';

/** Moves that pin a foe in place (the volatile kind). */
const TRAP_MOVES: ReadonlySet<string> = new Set([
  'block', 'meanlook', 'jawlock', 'anchorshot', 'spiritshackle', 'thousandwaves', 'octolock',
]);
/** Abilities that pin, with their conditions. */
const TRAP_ABILITIES: ReadonlySet<string> = new Set(['shadowtag', 'arenatrap', 'magnetpull']);
/** Pivots that bypass trapping AND clear the clock. Baton Pass is deliberately absent. */
const ESCAPE_PIVOTS: ReadonlySet<string> = new Set([
  'uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport', 'chillyreception', 'shedtail',
]);

export type PerishOutKind =
  | 'pivot' | 'shed-shell' | 'ghost' | 'ko-trapper' | 'taunt-singer' | 'soundproof' | 'partner-switch';

export interface PerishOut {
  kind: PerishOutKind;
  /** What to actually do, phrased as an instruction. */
  label: string;
  /** Does this SAVE the mon, or merely limit the damage? */
  saves: boolean;
}

export interface PerishTrapAdvice {
  /** 'active' — a clock is already running. 'armed' — the pieces are on the field. */
  phase: 'armed' | 'active';
  /** Turns until the first faint (the lowest live count). */
  turnsLeft?: number;
  /** My mons on the clock that cannot simply walk away. */
  victims: string[];
  singer?: string;
  trapper?: string;
  outs: PerishOut[];
  headline: string;
}

export interface PerishSide {
  species: string;
  ability?: string | null;
  item?: string | null;
  moves: readonly string[];
  active: boolean;
  hpPercent: number;
  perishCount?: number;
  /** Index of the foe holding this mon with a trapping MOVE, if any. */
  trappedByFoe?: number | null;
}

const has = (m: PerishSide, id: string) => m.moves.some(x => toId(x) === id);
const isType = (species: string, t: string): boolean =>
  (((getSpecies(species) as { types?: string[] } | undefined)?.types) ?? []).includes(t);
const isGrounded = (m: PerishSide): boolean =>
  !isType(m.species, 'Flying') && toId(m.ability ?? '') !== 'levitate';

/** Does an ABILITY on the foe's field pin this mon? Mirrors endgameSearch.trappedBy. */
function abilityTrapper(me: PerishSide, foes: readonly PerishSide[]): PerishSide | null {
  if (isType(me.species, 'Ghost')) return null;
  if (toId(me.item ?? '') === 'shedshell') return null;
  for (const f of foes) {
    if (!f.active || f.hpPercent <= 0) continue;
    const ab = toId(f.ability ?? '');
    if (ab === 'shadowtag' && toId(me.ability ?? '') !== 'shadowtag') return f;
    if (ab === 'arenatrap' && isGrounded(me)) return f;
    if (ab === 'magnetpull' && isType(me.species, 'Steel')) return f;
  }
  return null;
}

/** Can this mon leave the field at will, ignoring any pivot move it might have? */
function canWalkAway(me: PerishSide, foes: readonly PerishSide[]): boolean {
  if (isType(me.species, 'Ghost')) return true;
  if (toId(me.item ?? '') === 'shedshell') return true;
  const moveTrapped = me.trappedByFoe != null && me.trappedByFoe >= 0
    && !!foes[me.trappedByFoe]?.active && (foes[me.trappedByFoe]?.hpPercent ?? 0) > 0;
  return !moveTrapped && !abilityTrapper(me, foes);
}

/**
 * Analyse a live board for a perish trap. Returns null when there's nothing to say —
 * no song in play and no combo assembled — so callers can surface it unconditionally.
 */
export function analyzePerishTrap(mine: readonly PerishSide[], opp: readonly PerishSide[]): PerishTrapAdvice | null {
  const myActive = mine.filter(m => m.active && m.hpPercent > 0);
  const oppActive = opp.filter(o => o.active && o.hpPercent > 0);
  if (!myActive.length) return null;

  const singer = oppActive.find(o => has(o, 'perishsong'));
  const trapperOf = (me: PerishSide): PerishSide | null => {
    if (me.trappedByFoe != null && me.trappedByFoe >= 0) {
      const t = opp[me.trappedByFoe];
      if (t?.active && t.hpPercent > 0) return t;
    }
    return abilityTrapper(me, opp);
  };

  // --- ACTIVE: a clock is already running on someone of mine.
  const onClock = myActive.filter(m => (m.perishCount ?? 0) > 0);
  if (onClock.length) {
    const stuck = onClock.filter(m => !canWalkAway(m, opp));
    const turnsLeft = Math.min(...onClock.map(m => m.perishCount ?? 99));
    const victims = (stuck.length ? stuck : onClock).map(m => m.species);
    const trapper = stuck.length ? trapperOf(stuck[0]!) : null;
    const outs: PerishOut[] = [];

    for (const m of stuck) {
      const pivot = m.moves.find(mv => ESCAPE_PIVOTS.has(toId(mv)));
      if (pivot) outs.push({ kind: 'pivot', saves: true,
        label: `${m.species}: ${pivot} out — pivot moves bypass the trap AND clear the clock` });
      if (has(m, 'batonpass')) outs.push({ kind: 'pivot', saves: false,
        label: `${m.species}: NOT Baton Pass — it escapes the trap but hands the perish count to whatever comes in` });
    }
    if (trapper) {
      const viaMove = stuck.some(m => m.trappedByFoe != null && m.trappedByFoe >= 0);
      outs.push({ kind: 'ko-trapper', saves: turnsLeft >= 2,
        label: `KO ${trapper.species}${viaMove ? '' : ` (${trapper.ability})`} — the trap dies with it, freeing the switch${turnsLeft >= 2 ? '' : ' (too late this turn: the clock hits 0 first)'}` });
    }
    for (const m of myActive) {
      if ((m.perishCount ?? 0) > 0 && canWalkAway(m, opp) && !stuck.includes(m)) {
        outs.push({ kind: 'partner-switch', saves: true,
          label: `${m.species} is NOT trapped — switch it out to clear its own count` });
      }
    }

    const headline = stuck.length
      ? `☠ PERISH TRAP — ${victims.join(' + ')} ${victims.length > 1 ? 'are' : 'is'} on ${turnsLeft} and cannot leave`
      : `☠ Perish count running (${turnsLeft}) — switch to clear it`;
    return { phase: 'active', turnsLeft, victims, singer: singer?.species, trapper: trapper?.species ?? undefined, outs, headline };
  }

  // --- ARMED: the pieces are on the field but no song has landed yet.
  if (!singer) return null;
  const trapPiece = oppActive.find(o =>
    o.moves.some(mv => TRAP_MOVES.has(toId(mv))) || TRAP_ABILITIES.has(toId(o.ability ?? '')));
  if (!trapPiece) return null;

  const outs: PerishOut[] = [];
  for (const m of myActive) {
    if (toId(m.ability ?? '') === 'soundproof') {
      outs.push({ kind: 'soundproof', saves: true, label: `${m.species} has Soundproof — the song can't touch it` });
    }
    if (has(m, 'taunt')) {
      outs.push({ kind: 'taunt-singer', saves: true,
        label: `${m.species}: Taunt ${singer.species} before it sings — Perish Song is a status move` });
    }
    const pivot = m.moves.find(mv => ESCAPE_PIVOTS.has(toId(mv)));
    if (pivot && !canWalkAway(m, opp)) {
      outs.push({ kind: 'pivot', saves: true, label: `${m.species}: keep ${pivot} available as the escape` });
    }
  }
  outs.push({ kind: 'ko-trapper', saves: true,
    label: `KO ${trapPiece.species} before the song lands — without the trap the song is just a shared clock` });

  return {
    phase: 'armed',
    victims: myActive.filter(m => !canWalkAway(m, opp)).map(m => m.species),
    singer: singer.species,
    trapper: trapPiece.species,
    outs,
    headline: `⚠ Perish trap on the field — ${singer.species} sings, ${trapPiece.species} traps`,
  };
}

/** Is this move the perish song itself? (Exported for the tactics/vision layers.) */
export function isPerishSong(move: string | null | undefined): boolean {
  return toId(move ?? '') === 'perishsong';
}

/** Does this move pin a foe? */
export function isTrapMove(move: string | null | undefined): boolean {
  const id = toId(move ?? '');
  return TRAP_MOVES.has(id) || !!(getMove(id) as { volatileStatus?: string } | undefined)?.volatileStatus?.includes('trap');
}
