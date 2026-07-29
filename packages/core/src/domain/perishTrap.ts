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
import { getMegaOptions, megaFormeAbility } from './gimmicks/mega.js';

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
  /** The move a Choice item has locked this mon into, if it has already moved. A locked
   *  mon CANNOT click a pivot unless the pivot IS the locked move — offering "U-turn out"
   *  to a Choice-Scarf Garchomp locked into Earthquake is illegal advice, which is worse
   *  than saying nothing (caught by the user, 2026-07-28). */
  choiceLockedMove?: string | null;
}

const has = (m: PerishSide, id: string) => m.moves.some(x => toId(x) === id);

/** The ability this mon will have if it megas — Mega GENGAR gets SHADOW TAG, which is
 *  the whole trap in the Reg M-B perish core. Reading the base forme's ability alone
 *  ("Cursed Body") hides it completely until the mega has already happened. */
function megaAbilityOf(m: PerishSide): string | null {
  if (!m.item) return null;
  const opt = getMegaOptions(m.species).find(o => toId(o.stone) === toId(m.item ?? ''));
  return opt ? (megaFormeAbility(opt.forme) ?? null) : null;
}

/** Every trapping ability this mon can present — now, or after it megas. */
function trapAbilitiesOf(m: PerishSide): string[] {
  return [m.ability, megaAbilityOf(m)]
    .map(a => toId(a ?? ''))
    .filter(a => TRAP_ABILITIES.has(a));
}

/** Can this mon trap at all — by move or by ability (including its mega's)? */
function isTrapper(m: PerishSide): boolean {
  return trapAbilitiesOf(m).length > 0 || m.moves.some(mv => TRAP_MOVES.has(toId(mv)));
}

/** A species that COULD trap once it megas, even though we haven't seen the stone. An
 *  unrevealed bench Gengar is exactly the shape of the live 2026-07-28 loss: nothing in
 *  the observed data says "trapper" until the mega lands, at which point it's too late.
 *  Kept separate from isTrapper so a suspicion is never reported as a fact. */
function couldMegaTrap(m: PerishSide): boolean {
  if (isTrapper(m)) return false;             // already known — not a suspicion
  if (m.item) return false;                   // item known and it isn't the stone
  return getMegaOptions(m.species)
    .some(o => TRAP_ABILITIES.has(toId(megaFormeAbility(o.forme) ?? '')));
}
const CHOICE_ITEMS: ReadonlySet<string> = new Set(['choiceband', 'choicespecs', 'choicescarf']);
const holdsChoice = (m: PerishSide) => CHOICE_ITEMS.has(toId(m.item ?? ''));
/** The escape pivot this mon can ACTUALLY click, honouring any Choice lock. */
function usablePivot(m: PerishSide): string | null {
  const pivot = m.moves.find(mv => ESCAPE_PIVOTS.has(toId(mv)));
  if (!pivot) return null;
  const locked = m.choiceLockedMove;
  if (locked && toId(locked) !== toId(pivot)) return null;   // locked into something else
  return pivot;
}
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
    for (const ab of trapAbilitiesOf(f)) {
      if (ab === 'shadowtag' && toId(me.ability ?? '') !== 'shadowtag') return f;
      if (ab === 'arenatrap' && isGrounded(me)) return f;
      if (ab === 'magnetpull' && isType(me.species, 'Steel')) return f;
    }
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
    // Anyone else on their team who could re-trap once a slot opens (see the KO branch).
    const reliefTrappers = trapper
      ? opp.filter(o => o !== trapper && (o.hpPercent ?? 0) > 0 && isTrapper(o))
      : [];
    // Softer signal: unrevealed mons whose mega forme traps.
    const suspects = trapper
      ? opp.filter(o => o !== trapper && (o.hpPercent ?? 0) > 0 && couldMegaTrap(o))
      : [];

    for (const m of stuck) {
      const pivot = usablePivot(m);
      if (pivot) {
        outs.push({ kind: 'pivot', saves: true,
          label: `${m.species}: ${pivot} out — pivot moves bypass the trap AND clear the clock${holdsChoice(m) && !m.choiceLockedMove ? ' (click it FIRST — a Choice item locks you into whatever you use)' : ''}` });
      } else if (m.choiceLockedMove && m.moves.some(mv => ESCAPE_PIVOTS.has(toId(mv)))) {
        // It owns a pivot but can't reach it. Say so rather than staying silent — the
        // player may be about to look for the escape that isn't there.
        outs.push({ kind: 'pivot', saves: false,
          label: `${m.species}: its pivot is unavailable — Choice-locked into ${m.choiceLockedMove}` });
      }
      if (has(m, 'batonpass') && (!m.choiceLockedMove || toId(m.choiceLockedMove) === 'batonpass')) {
        outs.push({ kind: 'pivot', saves: false,
          label: `${m.species}: NOT Baton Pass — it escapes the trap but hands the perish count to whatever comes in` });
      }
    }
    if (trapper) {
      const viaMove = stuck.some(m => m.trappedByFoe != null && m.trappedByFoe >= 0);
      // A KO OPENS A SLOT THE OPPONENT CHOOSES TO FILL. Live 2026-07-28: KOing the
      // Mean Look Blastoise is exactly how the Mega Gengar got back in and re-applied
      // Shadow Tag — the "escape" handed them the swap for free. So a relief KO is only
      // an out when their remaining team has nobody left to re-trap with.
      const relief = reliefTrappers;
      const inTime = turnsLeft >= 2;
      if (relief.length) {
        outs.push({ kind: 'ko-trapper', saves: false,
          label: `Do NOT bank on KOing ${trapper.species} — it just opens the slot for ${relief.map(r => r.species).join('/')} to come back and re-trap` });
      } else if (suspects.length) {
        outs.push({ kind: 'ko-trapper', saves: false,
          label: `KOing ${trapper.species} frees the switch — but ${suspects.map(r => r.species).join('/')} can mega into a trapping ability, so the slot may just be refilled` });
      } else {
        outs.push({ kind: 'ko-trapper', saves: inTime,
          label: `KO ${trapper.species}${viaMove ? '' : ` (${trapper.ability ?? megaAbilityOf(trapper) ?? 'trapping ability'})`} — nothing left on their side re-traps, so the switch opens${inTime ? '' : ' (too late: the clock hits 0 first)'}` });
      }
    }
    for (const m of myActive) {
      if ((m.perishCount ?? 0) > 0 && canWalkAway(m, opp) && !stuck.includes(m)) {
        outs.push({ kind: 'partner-switch', saves: true,
          label: `${m.species} is NOT trapped — switch it out to clear its own count` });
      }
    }

    // Three distinct situations, and conflating them is what makes advice useless.
    // CERTAIN escape — a pivot it can actually click, Shed Shell, Ghost typing.
    // CONDITIONAL — only breaking the trap by KO, which this layer cannot promise
    // because it has no damage numbers; the player has the grid for that.
    // NONE — say so, and redirect to spending the mon well.
    const certain = outs.some(o => o.saves && (o.kind === 'pivot' || o.kind === 'shed-shell' || o.kind === 'ghost'));
    const conditional = !certain && outs.some(o => o.saves && o.kind === 'ko-trapper');
    if (stuck.length && !certain && !conditional) {
      const m = stuck[0]!;
      const why = m.choiceLockedMove
        ? `Choice-locked into ${m.choiceLockedMove}, no pivot available`
        : 'no pivot, no Shed Shell';
      // What to do with a mon that is already dead. NOT "hit the trapper" when a spare
      // trapper is waiting — that KO is how they rotate the real one back in.
      const spend = reliefTrappers.length
        ? `Spend it on the mon you actually need dead — do NOT clear the trapper's slot for ${reliefTrappers.map(r => r.species).join('/')}`
        : suspects.length
          ? `Spend it on the mon you actually need dead — ${suspects.map(r => r.species).join('/')} may mega into a trap and refill the slot`
          : 'Spend it: hit the trapper, and get the partner out.';
      outs.unshift({ kind: 'pivot', saves: false,
        label: `${m.species} CANNOT escape (${why}) — it faints in ${turnsLeft}. ${spend}` });
    }

    const suffix = certain ? ' and cannot leave'
      : conditional ? ` — only out: KO ${trapper?.species ?? 'the trapper'}`
      : ' — NO ESCAPE';
    const headline = stuck.length
      ? `☠ PERISH TRAP — ${victims.join(' + ')} ${victims.length > 1 ? 'are' : 'is'} on ${turnsLeft}${suffix}`
      : `☠ Perish count running (${turnsLeft}) — switch to clear it`;
    return { phase: 'active', turnsLeft, victims, singer: singer?.species, trapper: trapper?.species ?? undefined, outs, headline };
  }

  // --- ARMED: the pieces are on the field but no song has landed yet.
  if (!singer) return null;
  // isTrapper, not a raw ability read: a Gengarite Gengar shows "Cursed Body" until it
  // megas, and by then the tag is already on.
  const trapPiece = oppActive.find(isTrapper);
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
  const soloCombo = trapPiece === singer;
  // Same lesson as the active branch, applied one turn EARLIER — which is the turn that
  // actually decides the game. A body in front of a Gengar is not the trap; killing it
  // just rotates the real trapper in. Suspicion counts here too: at this point the stone
  // is usually still unrevealed, so "could mega into a trap" is all the warning there is.
  const live = opp.filter(o => o !== trapPiece && (o.hpPercent ?? 0) > 0);
  const spares = live.filter(isTrapper);
  const suspects = live.filter(couldMegaTrap);
  const refill = [...spares, ...suspects];
  outs.push({ kind: 'ko-trapper', saves: !refill.length,
    label: soloCombo
      ? `KO ${trapPiece.species} before the song lands — it sings AND traps, so it is the whole combo`
      : refill.length
        ? `KO ${trapPiece.species} before the song lands — but ${refill.map(s2 => s2.species).join('/')} ${spares.length ? 'can trap too' : 'can mega into a trapping ability'}, so removing this one may just rotate the real trapper in`
        : `KO ${trapPiece.species} before the song lands — without the trap the song is just a shared clock` });
  // The singer is the piece that starts the clock: deny it and nothing else matters.
  // Stated separately from the Taunt out, which only exists if I actually carry Taunt.
  if (!soloCombo && refill.length) {
    outs.push({ kind: 'taunt-singer', saves: false,
      label: `${singer.species} is the piece to remove — shut the song down or leave BEFORE it goes off; the trap only needs one turn to assemble` });
  }

  return {
    phase: 'armed',
    victims: myActive.filter(m => !canWalkAway(m, opp)).map(m => m.species),
    singer: singer.species,
    trapper: trapPiece.species,
    outs,
    headline: soloCombo
      ? `⚠ Perish trap on the field — ${singer.species} both sings and traps`
      : `⚠ Perish trap on the field — ${singer.species} sings, ${trapPiece.species} traps`,
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
