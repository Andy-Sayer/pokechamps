// Assemble a stream of parsed BattleMessages into turn-log lines. This is the
// event→turn-log core that sits between bannerParse (text→event) and the existing
// emitTurnLog (TurnObservation→lines). Its job is the part the banner text DOESN'T
// give directly: which SLOT (m1/m2/o1/o2) each event belongs to.
//
//   parseBanner ─▶ BattleMessage ─▶ [BattleAssembler] ─▶ TurnObservation ─▶ emitTurnLog
//
// The banner names a mon by SIDE + species ("The opposing Raichu used Fake Out!"),
// but the turn-log needs the slot. So we track the active roster (2 slots per side),
// updated by switches/faints, and resolve species→slot. Targets aren't stated in the
// banner either, so we infer them from the follow-up line that names the affected mon
// (flinch / effectiveness / faint → that's who the move hit). Damage % still comes
// from the HP read (nameplate OCR), wired in later — left undefined here.
//
// SCOPE (v1): roster tracking + slot resolution + move/mega/switch/ko lines with
// inferred targets. NOT yet handled: damage % (needs HP reads), turn segmentation
// (caller calls endTurn), and distinguishing a chosen switch from a move-induced or
// post-faint replacement (all currently surface as a switch line — see notes).

import type { BattleMessage, Side } from './bannerParse.js';
import { matchSpecies, similarity } from './fuzzyMatch.js';
import type { SlotRef, TurnAction, TurnObservation } from './types.js';
import { emitTurnLog } from './turnLog.js';
import { getMove, toId } from '@pokechamps/core/domain/data.js';

/** Is this move a damaging (opponent-targeting) move, vs a Status/self move? Unknown
 *  (garbled OCR) → treated as non-damaging so we don't wrongly point it at a foe. */
function isOffensive(move: string | undefined): boolean {
  const cat = move ? getMove(toId(move))?.category : undefined;
  return cat === 'Physical' || cat === 'Special';
}

export interface Roster { m1: string | null; m2: string | null; o1: string | null; o2: string | null; }

const slotsFor = (side: Side): [SlotRef, SlotRef] => (side === 'mine' ? ['m1', 'm2'] : ['o1', 'o2']);
const sideOf = (ref: SlotRef): Side => (ref[0] === 'm' ? 'mine' : 'opp');
const norm = (s: string | null): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** One HP read on the per-ACTION timeline. `tag` = how many actions had been fed when
 *  the read arrived, so tag t sits BETWEEN action t-1's banner and action t's banner —
 *  the window where action t-1's damage animation lands. `stable` = the value repeated
 *  across consecutive frames (settled, not mid-drain). `raw` = mine-side exact
 *  on-screen HP ("117/175" → 117) — what the turn-log must carry for m-slots. */
interface HpSample { tag: number; pct: number; stable: boolean; raw?: number; }

export class BattleAssembler {
  private roster: Roster;
  private actions: TurnAction[] = [];
  private faints: SlotRef[] = [];
  private notes: string[] = [];
  private stateLines: string[] = [];    // stat-boost lines (Intimidate, Nasty Plot, …) this turn
  private megaPending = new Set<SlotRef>();
  private hpSamples: Partial<Record<SlotRef, HpSample[]>> = {};
  private protectedThisTurn = new Set<SlotRef>();   // Protect users — no damage inferred onto them
  private confused = new Set<SlotRef>();            // carries ACROSS turns (confusion lasts 2-5)
  private lastConfusionRef: SlotRef | null = null;  // most recent "X is/became confused!" this turn
  private selfDamaged = new Set<SlotRef>();         // hurt ITSELF this turn — turn-final HP is not foe damage
  private missedTargets = new Set<string>();        // "actionIdx:ref" pairs where the move missed
  private vacatedByFaint = new Set<SlotRef>();      // slots emptied by a faint — the next switch-in there is a REPLACEMENT (persists across turns: the send-in often lands in the next proposal)
  private vacatedSpecies: Partial<Record<SlotRef, string>> = {};  // who fainted there — the dead mon's plate lingers a few frames and must not re-seed its own vacated slot
  private turnsClosed = 0;                          // turns emitted so far — guards the pair-order swap to pre-first-emission
  // NICKNAME ALIASES: a nicknamed mon's banners carry the nickname, never the species.
  // A Latin nickname OCRs stably, so binding label→slot once (from the send-out pair,
  // aligned against the slot the RESOLVABLE partner didn't claim) makes every later
  // "The opposing Courtois used X" resolve. Cleared when the slot changes occupant.
  private nickAlias: Partial<Record<SlotRef, string>> = {};

  /** Seed the two leads per side (from the team-preview / nameplate appearance read). */
  constructor(leads: Partial<Roster> = {}) {
    this.roster = { m1: null, m2: null, o1: null, o2: null, ...leads };
  }

  /** Current active roster (slot → species), read-only snapshot. */
  getRoster(): Roster { return { ...this.roster }; }

  /** Turns emitted so far (endTurn calls). */
  getTurnsClosed(): number { return this.turnsClosed; }

  /** Reset ALL per-match state. A long-running reader (spanning matches) carried the
   *  previous match's roster, nickname aliases, and faint-vacancy flags into the next
   *  one — a voluntary switch then emitted as a REPLACEMENT off a stale vacancy. */
  resetMatch(): void {
    this.roster = { m1: null, m2: null, o1: null, o2: null };
    this.actions = []; this.faints = []; this.notes = []; this.stateLines = [];
    this.megaPending.clear(); this.hpSamples = {}; this.protectedThisTurn.clear();
    this.missedTargets.clear(); this.vacatedByFaint.clear(); this.nickAlias = {};
    this.vacatedSpecies = {};
    this.confused.clear(); this.selfDamaged.clear(); this.lastConfusionRef = null;
    this.turnsClosed = 0;
  }

  /** Anything pending that would be lost if the stream ended now? (Not just actions —
   *  a faint/state line with no following action must still flush, or the match-ending
   *  KO vanishes: the gap-flush after the last damaging move clears the actions, and
   *  the faint banner lands after it with nothing else to close the turn.) */
  hasPending(): boolean {
    return this.actions.length > 0 || this.faints.length > 0 || this.stateLines.length > 0 || this.megaPending.size > 0;
  }

  /** Would this move banner be a SECOND, DIFFERENT move by the same actor this turn?
   *  A mon acts once per turn, so that's a missed turn boundary (the move-select gap
   *  was shorter than the gap threshold) — the tracker closes the turn first. A SAME
   *  move repeat stays a banner re-fire (handled by the feed dedupe), so a Choice-locked
   *  mon can't trigger a false split. */
  moveStartsNewTurn(side: Side, label: string, move: string): boolean {
    const ref = this.resolveSlot(side, label);
    if (!ref) return false;
    // CLEARLY different moves only: a re-OCR of the same banner varies by a glyph or
    // two ("Fake Out" → "Fake Qut") and must stay a re-fire, not a boundary — a false
    // split shipped a one-line garbage turn live. Real different moves by one mon
    // ("Brave Bird" vs "Tailwind") sit far below 0.7 similarity.
    return this.actions.some(a => a.kind === 'move' && a.actor === ref && similarity(a.move ?? '', move) < 0.7);
  }

  /** Swap the two slots of one side — roster, per-turn state, and every recorded ref.
   *  Used when confident nameplate reads prove the opening send-out banner listed the
   *  pair in the OPPOSITE order of the on-screen plates (seen live: "sent out Charizard
   *  and Hawlucha!" with plates showing Hawlucha left / Charizard right — every opp HP
   *  read was crossed for the rest of the match). Only safe before anything was emitted;
   *  the caller guards on getTurnsClosed() === 0. */
  swapPair(side: Side): void {
    const [a, b] = slotsFor(side);
    const swapRef = (r: SlotRef): SlotRef => (r === a ? b : r === b ? a : r);
    [this.roster[a], this.roster[b]] = [this.roster[b], this.roster[a]];
    [this.nickAlias[a], this.nickAlias[b]] = [this.nickAlias[b], this.nickAlias[a]];
    [this.vacatedSpecies[a], this.vacatedSpecies[b]] = [this.vacatedSpecies[b], this.vacatedSpecies[a]];
    // hpSamples deliberately NOT swapped: they're recorded from PHYSICAL plate refs
    // (already true-plate space — the space the swap converts everything else INTO).
    // Swapping them crossed correct samples onto the wrong slot and tripped the
    // zero-drop guard on real hits.
    for (const act of this.actions) {
      act.actor = swapRef(act.actor);
      if (act.target) act.target = swapRef(act.target);
      if (act.spread) for (const s of act.spread) s.ref = swapRef(s.ref);
      if (act.kind === 'state' && act.stateLine) act.stateLine = act.stateLine.replace(new RegExp(`^(${a}|${b})\\b`), m0 => (m0 === a ? b : a));
    }
    this.faints = this.faints.map(swapRef);
    this.megaPending = new Set([...this.megaPending].map(swapRef));
    this.protectedThisTurn = new Set([...this.protectedThisTurn].map(swapRef));
    this.vacatedByFaint = new Set([...this.vacatedByFaint].map(swapRef));
    this.confused = new Set([...this.confused].map(swapRef));
    this.selfDamaged = new Set([...this.selfDamaged].map(swapRef));
    if (this.lastConfusionRef) this.lastConfusionRef = swapRef(this.lastConfusionRef);
    this.missedTargets = new Set([...this.missedTargets].map(k => {
      const [i, r] = k.split(':');
      return `${i}:${swapRef(r as SlotRef)}`;
    }));
    this.stateLines = this.stateLines.map(l => l.replace(new RegExp(`^(${a}|${b})\\b`), m0 => (m0 === a ? b : a)));
  }

  /** Fill an UNKNOWN active slot from a confident per-frame species OCR. This is what lets a reader
   *  that JOINED the battle mid-stream — started after send-out, with no `--leads` — resolve
   *  "X used Y" banners to a slot. Without it the roster stays null, every move is dropped as
   *  unresolved, and turns emit empty (nothing gets keyed in). Purely additive: a slot already
   *  tracked (via a lead, a send-out banner, or a prior seed) is left alone, so OCR flicker during
   *  a switch/faint animation can't clobber a known mon. */
  seedActiveIfUnknown(ref: SlotRef, species: string, confidence = 0): void {
    if (this.roster[ref] == null) {
      // The just-fainted mon's nameplate lingers a few frames — re-seeding it into
      // its own vacated slot stole the REPLACEMENT's slot (the send-in then landed
      // in the wrong slot and clobbered its neighbour).
      if (this.vacatedSpecies[ref] && norm(this.vacatedSpecies[ref]!) === norm(species)) return;
      this.roster[ref] = species; return;
    }
    // PLATE OVERRIDE: a slot occupied by a GARBLED label (a banner OCR that never
    // resolves to a legal species — seen live with a Japanese-nicknamed opponent)
    // yields to a high-confidence canonical plate read; the plate index is ground
    // truth. A label that resolves (real species, or a nickname the caller already
    // canonicalised) is never clobbered — OCR flicker can't overwrite a known mon.
    if (confidence >= 0.85) {
      const cur = matchSpecies(this.roster[ref]!);
      if (!cur || cur.score < 0.6) {
        // NEVER duplicate a species across the pair: if the plate species already
        // occupies the SIBLING slot, this is pair-ORDER evidence (banner order vs
        // plate order), not an identity fix — overwriting made Camerupt occupy BOTH
        // slots live (Earth Power → o1 while the mega → o2). Swap while nothing has
        // been emitted; later, just refuse.
        const [a, b] = slotsFor(sideOf(ref));
        const sib = ref === a ? b : a;
        if (norm(this.roster[sib]) === norm(species)) {
          if (this.turnsClosed === 0) { this.swapPair(sideOf(ref)); this.notes.push(`pair order corrected from plate (${species} at ${ref})`); }
          return;
        }
        this.roster[ref] = species;
      }
    }
  }

  /** In-progress lines for the CURRENT (unclosed) turn — a live preview for the ratify
   *  panel so the user sees the reader capturing (final targets resolve at endTurn). */
  preview(): string[] { return emitTurnLog({ actions: this.actions, faints: [], megas: [...this.megaPending], stateLines: this.stateLines.length ? [...this.stateLines] : undefined, confidence: 1, notes: [] }); }

  /** Record one per-frame HP read (percent) on the per-action timeline. This is what
   *  lets endTurn give each hit its OWN damage value when a target is hit more than
   *  once in a turn — the settled read between banner N and banner N+1 is move N's
   *  post-hit HP. Call on every frame; consecutive duplicates are collapsed. */
  recordHp(ref: SlotRef, pct: number, stable = false, raw?: number): void {
    const arr = (this.hpSamples[ref] ??= []);
    const tag = this.actions.length;
    const last = arr[arr.length - 1];
    if (last && last.tag === tag && last.pct === pct && last.stable === stable && last.raw === raw) return;
    arr.push({ tag, pct, stable, raw });
  }

  /** Last sample of `ref` with tag in [fromTag, toTag] — a settled (stable) read wins
   *  over an unsettled one because those can be mid-drain-animation frames. */
  private lastSample(ref: SlotRef, fromTag: number, toTag: number): HpSample | null {
    let stableS: HpSample | null = null, anyS: HpSample | null = null;
    for (const s of this.hpSamples[ref] ?? []) {
      if (s.tag < fromTag || s.tag > toTag) continue;
      if (s.stable) stableS = s;
      anyS = s;
    }
    return stableS ?? anyS;
  }

  /** The slot's HP just before action `i`'s banner (last sample with tag ≤ i), falling
   *  back to the turn-start HP. Samples are pushed in tag order, so scan-and-keep-last. */
  private baselineBefore(ref: SlotRef, i: number, hpBefore: Partial<Record<SlotRef, number>>): number {
    let v: number | null = null;
    for (const s of this.hpSamples[ref] ?? []) { if (s.tag > i) break; v = s.pct; }
    return v ?? hpBefore[ref] ?? 100;
  }

  private resolveSlot(side: Side, species: string | null): SlotRef | null {
    if (!species) return null;
    const [a, b] = slotsFor(side);
    const sp = norm(species);
    if (norm(this.roster[a]) === sp) return a;
    if (norm(this.roster[b]) === sp) return b;
    // Nickname alias (bound at send-out): exact-ish match on the remembered label.
    for (const r of [a, b]) {
      if (this.nickAlias[r] && similarity(this.nickAlias[r]!, species) >= 0.55) return r;
    }
    // FUZZY: a nicknamed mon's label OCRs differently on every read (non-Latin glyphs
    // come out as unstable garbage), so exact equality never binds. Similarity binds
    // the stable part of the garble…
    const simA = this.roster[a] ? similarity(this.roster[a]!, species) : 0;
    const simB = this.roster[b] ? similarity(this.roster[b]!, species) : 0;
    if (Math.max(simA, simB) >= 0.6 && simA !== simB) return simA > simB ? a : b;
    // …and ELIMINATION handles the rest: if exactly one slot holds a CLEAN species
    // name that this label clearly isn't, the actor must be the other, messy slot.
    if (this.roster[a] && this.roster[b]) {
      const cleanNotIt = (r: SlotRef): boolean => {
        const m = matchSpecies(this.roster[r]!);
        return !!m && m.score >= 0.75 && similarity(this.roster[r]!, species) < 0.5;
      };
      const messy = (r: SlotRef): boolean => { const m = matchSpecies(this.roster[r]!); return !m || m.score < 0.6; };
      if (cleanNotIt(a) && messy(b)) return b;
      if (cleanNotIt(b) && messy(a)) return a;
    }
    return null;
  }

  /** The most recent move that hit `side` and hasn't had its target pinned yet.
   *  `offensiveOnly` (the default) skips status moves — a faint/effectiveness banner
   *  follows a DAMAGING move, and pinning past it landed a faint's target on the
   *  opponent's Roost (seen live: `o1 > Roost > m1`). The drowsy pin passes false:
   *  Yawn is a status move that legitimately takes the named target. */
  private lastMoveInto(side: Side, offensiveOnly = true): TurnAction | undefined {
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const a = this.actions[i]!;
      if (a.kind === 'move' && a.target == null && !a.spread && sideOf(a.actor) !== side
        && (!offensiveOnly || isOffensive(a.move))) return a;
    }
    return undefined;
  }

  /** Pin the most recent move into `ref` as AIMED at it but dealing NO damage (a miss
   *  or an immunity) — the target is real data, a damage slot would be poison. */
  private markNoDamage(side: Side, ref: SlotRef | null): void {
    if (!ref) return;
    let act: TurnAction | undefined;
    for (let i = this.actions.length - 1; i >= 0 && !act; i--) {
      const x = this.actions[i]!;
      if (x.kind !== 'move' || sideOf(x.actor) === side) continue;
      if (x.target === ref || (x.target == null && !x.spread)) act = x;
    }
    if (!act) return;
    // Pin the aim on a SINGLE-target move (real data). A dex-SPREAD move must stay
    // unpinned: freezing its target on the immune/dodging foe hid the other, real
    // victim from target inference (EQ next to a Flying-type lost the survivor chip).
    const dexT = (getMove(toId(act.move ?? '')) as { target?: string } | undefined)?.target;
    const spreadMove = dexT === 'allAdjacentFoes' || dexT === 'allAdjacent';
    if (act.target == null && !spreadMove) act.target = ref;
    this.missedTargets.add(`${this.actions.indexOf(act)}:${ref}`);
  }

  /** A follow-up line (flinch/effectiveness/faint) names who a move hit → pin target.
   *  A SECOND named mon on a dex spread move (two "super effective on X!" lines, or a
   *  faint after an effectiveness pin) means the move hit both → convert the single
   *  pin to a spread list; per-target damage fills in at endTurn. */
  private attachTarget(side: Side, ref: SlotRef | null, offensiveOnly = true): void {
    if (!ref) return;
    const a = this.lastMoveInto(side, offensiveOnly);
    if (a) { a.target = ref; return; }
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const b = this.actions[i]!;
      if (b.kind !== 'move' || sideOf(b.actor) === side) continue;
      const dexTarget = (getMove(toId(b.move ?? '')) as { target?: string } | undefined)?.target;
      if (dexTarget !== 'allAdjacentFoes' && dexTarget !== 'allAdjacent') return;
      const refs = [...(b.spread?.map(s => s.ref) ?? []), ...(b.target ? [b.target] : [])];
      if (refs.includes(ref)) return;              // duplicate banner — already known
      b.spread = [...refs, ref].map(r => ({ ref: r, hpRemainingPercent: 0 }));
      b.target = undefined;
      return;
    }
  }

  /** Feed one parsed banner event; updates roster + the current turn's actions. */
  feed(msg: BattleMessage): void {
    switch (msg.kind) {
      case 'mega': {
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (ref) this.megaPending.add(ref);
        else this.notes.push(`mega: unresolved ${msg.side} "${msg.label}"`);
        break;
      }
      case 'move': {
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (!ref) { this.notes.push(`move: unresolved ${msg.side} "${msg.label}" (${msg.move})`); break; }
        // BANNER RE-FIRE dedupe: OCR drops a persisting banner for a couple of frames
        // mid-animation, the clear window expires, and the same banner parses again.
        // A mon acts once per turn, so an identical actor+move this turn is a re-read —
        // fuzzily: a re-read can garble a glyph ("Fake Out" → "Fake Qut"). When the
        // LATER read is the one that resolves in the dex, it fixes the recorded name.
        // (Seen live: doubled Acrobatics / Solar Beam attributed to two targets.)
        {
          const dup = this.actions.find(a => a.kind === 'move' && a.actor === ref && similarity(a.move ?? '', msg.move) >= 0.7);
          if (dup) {
            // getMove returns a STUB ({exists: false}) for unknown ids, never undefined.
            const real = (m: string) => (getMove(toId(m)) as { exists?: boolean } | undefined)?.exists === true;
            if (!real(dup.move ?? '') && real(msg.move)) dup.move = msg.move;
            break;
          }
        }
        const action: TurnAction = { actor: ref, kind: 'move', move: msg.move };
        if (this.megaPending.delete(ref)) action.mega = true;
        this.actions.push(action);
        break;
      }
      case 'switchIn': {
        const [a, b] = slotsFor(msg.side);
        // Re-fired send-out banner: dedupe on a switch ACTION already recorded this
        // turn — NOT on the roster, which the per-frame slot-OCR seeding may have
        // filled BEFORE the banner parsed (that race made real send-outs vanish).
        const spIn = norm(msg.species ?? msg.label);
        if (spIn && this.actions.some(x => x.kind === 'switch' && norm(x.switchTo ?? null) === spIn)) break;
        // FUZZY re-fire dedupe: a garbled send-out banner (nicknamed mon) re-OCRs as
        // DIFFERENT garbage each re-fire, so exact dedupe misses and each variant
        // stacked a bogus switch (seen live: three garbage switches in turn 0). Two
        // real same-turn switch-ins never look 55% alike; two garbles of one banner do.
        if (this.actions.some(x => x.kind === 'switch' && sideOf(x.actor) === msg.side && similarity(x.switchTo ?? '', msg.label) >= 0.55)) break;
        // Opening DOUBLE send-out: "X sent out A and B!" / "Go! A and B!" names both leads in
        // one banner. Split when BOTH halves resolve to real species (guards a nickname that
        // happens to contain "and") — resolveSpecies token-matches the pair to just one, so
        // we can't rely on species being null. When NEITHER slot is tracked yet (the opening,
        // by definition two mons) split even on unresolvable halves: a nicknamed lead's
        // garbled label still claims its slot, so later plate overrides / elimination can
        // bind it — collapsing the pair to one slot left the nicknamed mon unresolvable
        // for the whole match (seen live vs a Japanese-nicknamed opponent).
        const parts = msg.label.split(/\s+and\s+/i).map(s => s.trim()).filter(Boolean);
        if (parts.length === 2) {
          const r1 = matchSpecies(parts[0]!), r2 = matchSpecies(parts[1]!);
          const bothResolve = !!(r1 && r1.score >= 0.7 && r2 && r2.score >= 0.7);
          if (bothResolve || (this.roster[a] == null && this.roster[b] == null)) {
            const s1 = bothResolve ? r1!.value : parts[0]!;
            const s2 = bothResolve ? r2!.value : parts[1]!;
            this.roster[a] = s1; this.roster[b] = s2;
            this.actions.push({ actor: a, kind: 'switch', switchTo: s1 });
            this.actions.push({ actor: b, kind: 'switch', switchTo: s2 });
            break;
          }
          // Both slots already tracked (leads-seeded): the banner adds no occupancy,
          // but it can NAME a nickname. A part that resolves confirms its slot; the
          // unresolvable part is the OTHER slot's nickname — bind it as that slot's
          // alias so every later banner carrying it resolves ("sent out Courtois and
          // Camerupt!" with leads Milotic/Camerupt → "Courtois" aliases the Milotic slot).
          if (this.roster[a] != null && this.roster[b] != null) {
            const rs = [r1, r2];
            const claimed = new Set<SlotRef>();
            let nickIdx = -1;
            parts.forEach((_, i) => {
              const m = rs[i];
              if (m && m.score >= 0.7) {
                const slot = norm(this.roster[a]) === norm(m.value) ? a : norm(this.roster[b]) === norm(m.value) ? b : null;
                if (slot) claimed.add(slot);
              } else nickIdx = i;
            });
            if (nickIdx >= 0 && claimed.size === 1) {
              const open: SlotRef = claimed.has(a) ? b : a;
              this.nickAlias[open] = parts[nickIdx]!;
              this.notes.push(`nickname alias: "${parts[nickIdx]}" → ${open} (${this.roster[open]})`);
            }
            break;
          }
        }
        // An UNRESOLVABLE label with no empty slot to land in is a garbled re-fire or
        // nickname noise, never a real switch (a voluntary switch's "come back!" and a
        // faint both clear a slot first) — dropping it protects a leads-seeded roster
        // from being clobbered by garbage.
        if (msg.species == null && this.roster[a] != null && this.roster[b] != null) {
          this.notes.push(`switchIn dropped (unresolvable "${msg.label}", no open ${msg.side} slot)`);
          break;
        }
        // Prefer the slot the per-frame OCR already seeded with this species (the
        // plate index is ground truth), then the first empty slot.
        const target: SlotRef =
          spIn && norm(this.roster[a]) === spIn ? a :
          spIn && norm(this.roster[b]) === spIn ? b :
          this.roster[a] == null ? a : this.roster[b] == null ? b : a;
        const species = msg.species ?? msg.label;          // null species → keep the label (nickname) as a tag
        this.roster[target] = species;
        // A send-in filling a faint-vacated slot is a REPLACEMENT (→ `in` line), not a
        // chosen switch. Only when the species resolved — the `in` grammar needs a
        // species ref the parser can canonicalise; a nickname stays a switch line.
        // Replacement even when the label is garbled — if pass-0 later repairs the
        // species (plate override), the `in` grammar applies; if not, the line is
        // suppressed anyway, so a chosen-switch mislabel can't leak.
        const replacement = this.vacatedByFaint.has(target);
        this.vacatedByFaint.delete(target);
        delete this.vacatedSpecies[target];
        delete this.nickAlias[target];   // new occupant — the old nickname binding is stale
        this.confused.delete(target);    // …and volatiles don't survive the slot's old tenant
        if (this.lastConfusionRef === target) this.lastConfusionRef = null;
        this.actions.push({ actor: target, kind: 'switch', switchTo: species, replacement: replacement || undefined });
        break;
      }
      case 'switchOut': {
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (ref) {
          this.roster[ref] = null; delete this.nickAlias[ref];
          this.confused.delete(ref);   // confusion is a volatile — it's gone on switch-out
          if (this.lastConfusionRef === ref) this.lastConfusionRef = null;
        }
        break;
      }
      case 'faint': {
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (ref) {
          if (this.faints.includes(ref)) break;            // re-fired faint banner
          this.attachTarget(msg.side, ref); this.faints.push(ref);
          this.vacatedSpecies[ref] = this.roster[ref] ?? undefined;
          this.roster[ref] = null;
          delete this.nickAlias[ref];
          this.confused.delete(ref);
          if (this.lastConfusionRef === ref) this.lastConfusionRef = null;
          // The ko goes INTO the action timeline: emitted trailing, it would land after
          // the replacement's `in` line and faint the wrong (new) occupant of the slot.
          this.actions.push({ actor: ref, kind: 'ko' });
          this.vacatedByFaint.add(ref);
        }
        else this.notes.push(`faint: unresolved ${msg.side} "${msg.label}"`);
        break;
      }
      case 'flinch':
        this.attachTarget(msg.side, this.resolveSlot(msg.side, msg.species ?? msg.label));
        break;
      case 'effectiveness': {
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        // "It doesn't affect X…" pins the AIM but is a guaranteed ZERO — treat it like
        // a miss (target kept, no damage slot, never a spread hit). Pinning it as a
        // plain hit emitted a 0-damage spread entry on the immune foe (EQ next to a
        // Flying-type), which is exactly the inference poison the guards exist for.
        if (msg.level === 'immune') { this.markNoDamage(msg.side, ref); break; }
        this.attachTarget(msg.side, ref);
        break;
      }
      // "X grew drowsy!" names Yawn's target — the only target signal a STATUS move
      // gets (no effectiveness/damage follow-ups), else Yawn emits as `> self`.
      case 'drowsy':
        this.attachTarget(msg.side, this.resolveSlot(msg.side, msg.species ?? msg.label), false);
        break;
      case 'hpLoss': {
        // "X lost some of its HP!" right after X's own damaging move = the Life Orb
        // tell → a free item reveal (`o2 item Life Orb`), which also fires the item-
        // clause ripple across the other opp candidates. Gated on an offensive move by
        // X this turn so Substitute/Belly Drum/Curse self-cuts don't false-positive,
        // and on the move not being a self-cost move (Steel Beam etc.).
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (!ref) break;
        const SELF_COST = new Set(['steelbeam', 'mindblown', 'chloroblast']);
        const acted = this.actions.some(a =>
          a.kind === 'move' && a.actor === ref && isOffensive(a.move) && !SELF_COST.has(toId(a.move ?? '')));
        const line = `${ref} item Life Orb`;
        // IN the action timeline, not stateLines: trailing state lines emit after a
        // same-turn replacement `in` — the reveal would attribute the item to the
        // slot's NEW occupant (seen in the trace replay: Hawlucha's orb on Noivern).
        if (acted && !this.actions.some(a => a.kind === 'state' && a.stateLine === line))
          this.actions.push({ actor: ref, kind: 'state', stateLine: line });
        break;
      }
      case 'protect': {
        // "X protected itself!" — X took no move damage this turn, so an HP dip on it
        // (residual chip) must NOT be read as a hit: exclude it from window-drop target
        // inference and spread detection. (Its own Protect action line is separate.)
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (ref) this.protectedThisTurn.add(ref);
        break;
      }
      case 'confusionHit': {
        // "It hurt itself in its confusion!" — SELF-inflicted HP loss, and the banner
        // names nobody. Attribute it to the mon the confusion reminder just named (the
        // game prints "X is confused!" first), else to the only confused mon on the
        // field. Unattributed, the drop reads as an opponent's damage and poisons the
        // spread inference — the same failure class as an un-suppressed miss.
        const ref = this.lastConfusionRef
          ?? [...this.confused].filter(r => this.roster[r] != null)[0]
          ?? null;
        if (!ref) { this.notes.push('confusion self-hit seen but unattributed (no "X is confused!" line) — HP may be misread as foe damage'); break; }
        // WINDOW-scoped: the drop lands in the window of the action that's currently
        // open (samples are tagged with actions.length), so exclude just that window —
        // a real hit on this mon in ANOTHER window stays a valid observation.
        if (this.actions.length) this.missedTargets.add(`${this.actions.length - 1}:${ref}`);
        this.selfDamaged.add(ref);
        this.notes.push(`${ref} hurt itself in confusion — self-damage excluded from foe attribution`);
        break;
      }
      case 'miss':
        // "X avoided the attack!" — the most recent move into X missed: pin the target
        // (the aim is real data) but flag it so no damage slot is emitted; an
        // "unchanged HP" value would read as a 0-damage observation. (Seen live:
        // `o1 > Solar Beam > m1 > 100%` off a dodged Solar Beam.)
        this.markNoDamage(msg.side, this.resolveSlot(msg.side, msg.species ?? msg.label));
        break;
      case 'crit': {
        // "A critical hit!" tags the move whose damage just resolved — without the tag
        // its 1.5× observation reads as a fake super-high roll and poisons inference.
        // The doubles form names the TARGET ("A critical hit on X!") → also pins it.
        const ref = msg.side != null ? this.resolveSlot(msg.side, msg.species ?? msg.label ?? '') : null;
        let act: TurnAction | undefined;
        for (let i = this.actions.length - 1; i >= 0 && !act; i--) {
          const a = this.actions[i]!;
          if (a.kind !== 'move' || !isOffensive(a.move)) continue;
          if (ref) {
            if (sideOf(a.actor) === sideOf(ref)) continue;   // crit target is hit by the OTHER side
            if (a.target === ref || a.spread?.some(s => s.ref === ref) || (a.target == null && !a.spread)) act = a;
          } else act = a;                                     // unnamed form → the last damaging move
        }
        if (!act) { this.notes.push('crit banner with no damaging move to attach'); break; }
        if (ref && act.target == null && !act.spread) act.target = ref;
        act.crit = true;
        if (act.spread) this.notes.push(`crit on a spread move (${act.move}) — grammar tags the whole action, not the one target`);
        break;
      }
      case 'status': {
        // Non-volatile status ("X was burned!" …) → the `o1 brn` state line. Without
        // this the engine never learns the burn: a burned physical attacker's halved
        // hits mislead the Atk inference, and the EOT chip has no attributed source.
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (!ref) { this.notes.push(`status unresolved ${msg.side} "${msg.label}"`); break; }
        const MAP: Record<string, string> = { burn: 'brn', paralysis: 'par', poison: 'psn', toxic: 'tox', sleep: 'slp', freeze: 'frz' };
        const st = MAP[msg.status];
        if (st) this.stateLines.push(`${ref} ${st}`);
        else if (msg.status === 'confusion') {
          // Volatile — no state-line grammar, so it isn't keyed. But it IS the attribution
          // key for the sideless "It hurt itself in its confusion!" that may follow: the
          // game prints "X is confused!" immediately before the self-hit, every turn X
          // tries to move (live trace: "Pelipper is confused!" → "It hurt itself…").
          this.confused.add(ref); this.lastConfusionRef = ref;
          // The INFLICTION line also names who the move that just landed HIT — the same
          // signal class as flinch/effectiveness, and the only target evidence a neutral
          // confusing hit leaves. (The per-turn reminder names the mon about to ACT, not
          // a target, so it must never pin.) Live trace: the opposing Pelipper's Hurricane
          // confused MY Pelipper — without this pin the self-damage guard below pushed the
          // target onto the wrong mon entirely.
          if (!msg.reminder) this.attachTarget(msg.side, ref, false);
        }
        else this.notes.push(`${ref} ${msg.status} observed (volatile — no state-line grammar, not keyed)`);
        break;
      }
      case 'statChange': {
        // Stat boosts (Intimidate on switch-in, Nasty Plot, etc.) → a turn-log state line
        // `o1 -1 atk`. This is why the initial Intimidate was vanishing — it was dropped here.
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (!ref) { this.notes.push(`statChange unresolved ${msg.side} "${msg.label}"`); break; }
        const sign = msg.dir === 'rose' ? '+' : '-';
        const MAP: Record<string, string> = { attack: 'atk', defense: 'def', 'sp. atk': 'spa', 'sp. def': 'spd', speed: 'spe', accuracy: 'acc', evasiveness: 'eva' };
        const parts = msg.stats.map(s => MAP[s.toLowerCase()]).filter(Boolean).map(st => `${sign}${msg.magnitude} ${st}`);
        const line = `${ref} ${parts.join(' ')}`;
        // Re-fired banner dedupe (a repeated Intimidate/self-drop banner re-read). A
        // REAL second identical boost in one turn (two Intimidates from a double
        // switch-in) is also collapsed — rare, and the re-read is far more common.
        if (parts.length && !this.stateLines.includes(line)) this.stateLines.push(line);
        break;
      }
      case 'weatherStart': {
        // Drizzle/Rain Dance/etc. — set the field weather so damage calcs reflect it. bannerParse
        // gives 'rain'|'sandstorm'|'sun'|'snow'; the turn-log wants rain|sand|sun|snow.
        const MAP: Record<string, string> = { rain: 'rain', sandstorm: 'sand', sun: 'sun', snow: 'snow' };
        const w = MAP[msg.weather];
        if (w && !this.stateLines.includes(`weather ${w}`)) this.stateLines.push(`weather ${w}`);
        break;
      }
      case 'weatherEnd':
        if (!this.stateLines.includes('weather clear')) this.stateLines.push('weather clear');
        break;
      // heal / screen / megaReact / end → no turn-log action (yet)
      default: break;
    }
  }

  /** Close the current turn → its TurnObservation, and reset for the next. Pass the
   *  post-turn remaining HP% per slot (from the HP read, opp nameplate %, mine
   *  abs/max) to fill each damaging move's `hpRemainingPercent` — that's the damage
   *  signal the inference solver back-solves spreads from. When per-frame reads were
   *  recorded (recordHp), each move gets the settled HP from ITS OWN window of the
   *  turn, so two hits into the same target each carry their own damage; without
   *  samples this degrades to one turn-final read per slot. */
  endTurn(hpBySlot: Partial<Record<SlotRef, number>> = {}, hpBefore: Partial<Record<SlotRef, number>> = {}, touched?: Set<SlotRef>): TurnObservation {
    // What fell off `ref` in action i's IMMEDIATE window — between its banner and the
    // next one (or turn end). The sharpest per-action damage signal we have.
    const immDrop = (ref: SlotRef, i: number): number => {
      const to = i + 1 < this.actions.length ? i + 1 : Number.MAX_SAFE_INTEGER;
      const post = this.lastSample(ref, i + 1, to);
      if (post == null) return 0;
      return Math.max(0, this.baselineBefore(ref, i, hpBefore) - post.pct);
    };

    // PASS 0 — SWITCH LABEL REPAIR. A switch whose label never resolved to a species
    // (nicknamed mon → garbled OCR) can't emit as-is: the parser would choke on
    // `o1 > switch > <garbage>`. If the plate override has since put the CANONICAL
    // species into the slot, rewrite the label from the roster; otherwise keep the
    // action for the HP timeline but suppress its line.
    for (const a of this.actions) {
      if (a.kind !== 'switch' || !a.switchTo) continue;
      const m = matchSpecies(a.switchTo);
      if (m && m.score >= 0.6) continue;
      const cur = this.roster[a.actor] ? matchSpecies(this.roster[a.actor]!) : null;
      if (cur && cur.score >= 0.75) a.switchTo = cur.value;
      else { a.suppress = true; this.notes.push(`switch into ${a.actor} unresolved ("${a.switchTo}") — line suppressed`); }
    }

    // PASS 1 — SPREAD DETECTION. A dex spread move (allAdjacentFoes / allAdjacent)
    // whose window shows BOTH foes dropping is a spread hit → per-target damage list
    // (`> spread > o1:40, o2:35`). Values fill in pass 3. A banner-pinned target
    // (flinch/effectiveness named one mon) counts as hit without needing a sample, so
    // Rock Slide pinned by its flinch still captures the OTHER foe's chunk. Requires
    // per-frame samples; without them a pinned/unresolved move stays single-target.
    this.actions.forEach((a, i) => {
      if (a.kind !== 'move' || a.spread || !isOffensive(a.move)) return;
      const dexTarget = (getMove(toId(a.move ?? '')) as { target?: string } | undefined)?.target;
      if (dexTarget !== 'allAdjacentFoes' && dexTarget !== 'allAdjacent') return;
      const [f1, f2] = slotsFor(sideOf(a.actor) === 'mine' ? 'opp' : 'mine');
      const [s1, s2] = slotsFor(sideOf(a.actor));
      const ally = s1 === a.actor ? s2 : s1;
      const cands = (dexTarget === 'allAdjacent' ? [f1, f2, ally] : [f1, f2]).filter(r => !this.protectedThisTurn.has(r));
      // A banner-pinned target does NOT count as hit when the pin came from a MISS
      // banner ("Garchomp avoided the attack!" pins the aim, not a hit) — counting it
      // fabricated a spread entry with the dodger's unrelated later HP.
      // "Occupied at hit time" includes a foe this turn's faint has since nulled out
      // of the roster — a spread that KO'd one foe still chipped the other, and gating
      // on roster alone silently dropped the survivor's damage observation.
      const occupiedAtHit = (r: SlotRef) => this.roster[r] != null || this.faints.includes(r);
      const hit = cands.filter(r => occupiedAtHit(r) && !this.missedTargets.has(`${i}:${r}`) && (r === a.target || immDrop(r, i) >= 1));
      if (hit.filter(r => r !== ally).length >= 2) {
        a.spread = hit.map(ref => ({ ref, hpRemainingPercent: 0 }));
        a.target = undefined;
      }
    });

    // PASS 2 — TARGET INFERENCE for moves the banner didn't name (neutral single hits
    // emit no "effective on X" line). Priority, per the HUD's behaviour:
    //   1. the foe whose HP fell in THIS action's window — scoped per action, so a
    //      second hit into an already-claimed foe still resolves correctly.
    //   2. the foe whose NAMEPLATE APPEARED this turn — only affected mons show a plate.
    //   3. else the foe whose settled HP fell most over the whole turn.
    //   4. else, for an OFFENSIVE move, the first live foe (never "self").
    // 2-4 are turn-scoped signals, so `claimed` guards them against double-assignment;
    // the window signal (1) is per-action and may legitimately re-pick a claimed foe.
    // Status/self moves touch no foe + drop no foe HP → stay untargeted (correctly "self").
    const claimed = new Set<SlotRef>();
    const dropOf = (ref: SlotRef): number => { const after = hpBySlot[ref]; return after == null ? 0 : Math.max(0, (hpBefore[ref] ?? 100) - after); };
    this.actions.forEach((a, i) => {
      if (a.kind !== 'move' || a.target != null || a.spread || !isOffensive(a.move)) return;
      const [f1, f2] = slotsFor(sideOf(a.actor) === 'mine' ? 'opp' : 'mine');
      let pick = [f1, f2].filter(r => (this.roster[r] != null || this.faints.includes(r)) && !this.protectedThisTurn.has(r) && !this.missedTargets.has(`${i}:${r}`) && immDrop(r, i) >= 3)  // 1. window drop (a since-fainted foe still counts; never a missed/immune ref)
        .sort((x, y) => immDrop(y, i) - immDrop(x, i))[0];
      if (!pick) {
        // A mon that hurt ITSELF this turn is excluded from the TURN-scoped signals: its
        // plate appears and its turn-total HP drop is large for reasons that have nothing
        // to do with a foe's move, so both signals would preferentially (and wrongly) pick
        // it. Signal 1 above stays available — that one is window-scoped and the confused
        // mon's own window is already excluded, so a genuine hit in another window still
        // resolves.
        const foes = [f1, f2].filter(r => !claimed.has(r) && !this.missedTargets.has(`${i}:${r}`) && !this.selfDamaged.has(r));
        pick = foes.find(r => touched?.has(r) && this.roster[r]);                            // 2. plate appeared
        if (!pick) pick = foes.filter(r => dropOf(r) >= 3).sort((x, y) => dropOf(y) - dropOf(x))[0]; // 3. HP fell (turn)
        if (!pick) {                                                                          // 4. default to a live foe
          pick = foes.find(r => this.roster[r]) ?? f1;
          this.notes.push(`target defaulted (offensive, no plate/HP signal): ${a.move}→${pick}`);
        }
      }
      if (pick) { a.target = pick; claimed.add(pick); }
    });

    // PASS 3 — PER-ACTION HP ATTRIBUTION. A move's post-hit HP is the last settled
    // sample of its target BEFORE the next action that hits (or replaces) that slot —
    // that window is exclusively this move's outcome, animation lag included. No
    // sample in the window (no recordHp feed, or plates never settled) → fall back to
    // the turn-final read, which is exact whenever the slot was only hit once.
    const cutFor = (i: number, ref: SlotRef): number => {
      for (let k = i + 1; k < this.actions.length; k++) {
        const b = this.actions[k]!;
        if (b.kind === 'switch' && b.actor === ref) return k;
        if (b.kind === 'ko' && b.actor === ref) return k;   // faint ends the slot's window (plate is gone)
        if (b.kind === 'move' && (b.target === ref || b.spread?.some(s => s.ref === ref))) return k;
      }
      return Number.MAX_SAFE_INTEGER;
    };
    this.actions.forEach((a, i) => {
      if (a.kind !== 'move') return;
      if (a.spread) {
        // A Protected ref took no damage — drop it from the spread list (its "hit"
        // would be a 0-damage observation). Same for a ref the miss banner named.
        // One survivor → plain single-target line.
        a.spread = a.spread.filter(s => !this.protectedThisTurn.has(s.ref) && !this.missedTargets.has(`${i}:${s.ref}`));
        if (a.spread.length === 1) { a.target = a.spread[0]!.ref; a.spread = undefined; }
        else if (!a.spread.length) { a.spread = undefined; return; }
      }
      if (a.spread) {
        // Same self-damage rule as the single-target branch: a spread member whose only
        // available value is the turn-final read, when that read includes its own
        // confusion hit, is dropped from the list rather than billed to this move.
        a.spread = a.spread.filter(s =>
          !(this.selfDamaged.has(s.ref) && this.lastSample(s.ref, i + 1, cutFor(i, s.ref)) == null));
        if (a.spread.length === 1) { a.target = a.spread[0]!.ref; a.spread = undefined; }
        else if (!a.spread.length) { a.spread = undefined; return; }
      }
      if (a.spread) {
        for (const s of a.spread) {
          const smp = this.lastSample(s.ref, i + 1, cutFor(i, s.ref));
          s.hpRemainingPercent = smp?.pct ?? hpBySlot[s.ref] ?? this.baselineBefore(s.ref, i, hpBefore);
          if (smp?.raw != null) s.hpRemainingRaw = smp.raw;
        }
      } else if (a.target != null) {
        // Target Protected or the move MISSED → keep the target (the aim reveals the
        // move, feeds Choice-lock logic) but emit NO damage slot: an "unchanged HP"
        // value would read as a 0-damage observation and poison the spread inference.
        if (this.protectedThisTurn.has(a.target) || this.missedTargets.has(`${i}:${a.target}`)) return;
        // A STATUS move deals no damage — never attach an HP slot to it. (A drowsy-
        // pinned Yawn picked up the target's unrelated settled read: `> m1 > 27%`.)
        if (!isOffensive(a.move)) return;
        const smp = this.lastSample(a.target, i + 1, cutFor(i, a.target));
        // Self-damage (confusion) with no window sample: the only value left is the
        // TURN-FINAL read, which already has the self-hit baked in — emitting it would
        // bill this move for HP the mon took off itself. Better no observation than a
        // wrong one; the `hp` sync line below still keeps the engine's HP honest.
        if (smp == null && this.selfDamaged.has(a.target)) {
          this.notes.push(`damage slot suppressed (${a.move}→${a.target}): target self-damaged this turn, no clean window read`);
          return;
        }
        const pct = smp?.pct ?? hpBySlot[a.target];
        if (pct == null) return;
        // ZERO-DROP GUARD: an offensive move whose target shows NO HP drop at all is a
        // miss / unseen Protect / immunity / sub — whatever the cause, a 0-damage
        // observation is never useful and always poison. (The miss banner isn't always
        // OCR'd — a dodged Solar Beam still emitted `> 100%` on one replay run.) Only
        // when a prior turn closed with this slot's HP known (hpBefore) — a reader that
        // just JOINED has no baseline, and its first remaining-HP read is the state sync.
        if (isOffensive(a.move) && hpBefore[a.target] != null && pct >= this.baselineBefore(a.target, i, hpBefore)) {
          this.notes.push(`no damage observed (${a.move}→${a.target}: miss/Protect/immune?) — damage slot suppressed`);
          return;
        }
        a.hpRemainingPercent = pct;
        if (smp?.raw != null) a.hpRemainingRaw = smp.raw;
      }
    });
    // HP SYNC for self-damage. A confusion self-hit is real HP loss that we deliberately
    // bill to NOBODY, so no move line carries it — close the turn with an explicit bulk-HP
    // line for those slots instead (same value convention as a damage slot: m-side raw,
    // o-side percent). State lines emit after the actions, so this is the turn's last word
    // on that slot. Without it the engine's HP drifts above the screen for the rest of the
    // match, which is worse than the mis-attribution we just avoided.
    for (const ref of this.selfDamaged) {
      const smp = this.lastSample(ref, 0, Number.MAX_SAFE_INTEGER);
      const pct = smp?.pct ?? hpBySlot[ref];
      if (pct == null) continue;
      this.stateLines.push(`hp ${ref}=${ref.startsWith('m') ? (smp?.raw != null ? `${smp.raw}` : `${pct}%`) : `${pct}`}`);
    }

    // Megas whose MOVE was never captured (missed banner) still happened → emit them as
    // standalone mega lines so the forme change isn't lost.
    const megas = [...this.megaPending];
    const obs: TurnObservation = { actions: this.actions, faints: this.faints, megas: megas.length ? megas : undefined, stateLines: this.stateLines.length ? [...this.stateLines] : undefined, confidence: 1, notes: this.notes };
    this.turnsClosed++;
    // vacatedByFaint deliberately survives the reset — the replacement send-in usually
    // lands in the NEXT proposal (end-of-turn replacements cross the gap boundary).
    // `confused` deliberately survives the reset (confusion lasts 2-5 turns and the
    // reminder banner re-fires each turn) — it's cleared when the mon leaves the field.
    this.actions = []; this.faints = []; this.notes = []; this.stateLines = []; this.megaPending.clear(); this.hpSamples = {}; this.protectedThisTurn.clear(); this.missedTargets.clear();
    this.selfDamaged.clear(); this.lastConfusionRef = null;
    return obs;
  }

  /** Convenience: close the turn and emit its canonical turn-log lines. */
  endTurnLines(hpBySlot: Partial<Record<SlotRef, number>> = {}, hpBefore: Partial<Record<SlotRef, number>> = {}, touched?: Set<SlotRef>): string[] { return emitTurnLog(this.endTurn(hpBySlot, hpBefore, touched)); }
}
