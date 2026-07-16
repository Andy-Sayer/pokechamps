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
import { matchSpecies } from './fuzzyMatch.js';
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

  /** Seed the two leads per side (from the team-preview / nameplate appearance read). */
  constructor(leads: Partial<Roster> = {}) {
    this.roster = { m1: null, m2: null, o1: null, o2: null, ...leads };
  }

  /** Current active roster (slot → species), read-only snapshot. */
  getRoster(): Roster { return { ...this.roster }; }

  /** Fill an UNKNOWN active slot from a confident per-frame species OCR. This is what lets a reader
   *  that JOINED the battle mid-stream — started after send-out, with no `--leads` — resolve
   *  "X used Y" banners to a slot. Without it the roster stays null, every move is dropped as
   *  unresolved, and turns emit empty (nothing gets keyed in). Purely additive: a slot already
   *  tracked (via a lead, a send-out banner, or a prior seed) is left alone, so OCR flicker during
   *  a switch/faint animation can't clobber a known mon. */
  seedActiveIfUnknown(ref: SlotRef, species: string): void {
    if (this.roster[ref] == null) this.roster[ref] = species;
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
    return null;
  }

  /** The most recent move that hit `side` and hasn't had its target pinned yet. */
  private lastMoveInto(side: Side): TurnAction | undefined {
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const a = this.actions[i]!;
      if (a.kind === 'move' && a.target == null && !a.spread && sideOf(a.actor) !== side) return a;
    }
    return undefined;
  }

  /** A follow-up line (flinch/effectiveness/faint) names who a move hit → pin target.
   *  A SECOND named mon on a dex spread move (two "super effective on X!" lines, or a
   *  faint after an effectiveness pin) means the move hit both → convert the single
   *  pin to a spread list; per-target damage fills in at endTurn. */
  private attachTarget(side: Side, ref: SlotRef | null): void {
    if (!ref) return;
    const a = this.lastMoveInto(side);
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
        // A mon acts once per turn, so an identical actor+move this turn is a re-read.
        // (Seen live: doubled Acrobatics / Solar Beam attributed to two targets.)
        if (this.actions.some(a => a.kind === 'move' && a.actor === ref && norm(a.move ?? '') === norm(msg.move))) break;
        const action: TurnAction = { actor: ref, kind: 'move', move: msg.move };
        if (this.megaPending.delete(ref)) action.mega = true;
        this.actions.push(action);
        break;
      }
      case 'switchIn': {
        const [a, b] = slotsFor(msg.side);
        // Re-fired send-out banner: the named mon is already active on that side →
        // a re-read, not a second switch (species clause: no duplicate species).
        {
          const sp = norm(msg.species ?? msg.label);
          if (sp && (norm(this.roster[a]) === sp || norm(this.roster[b]) === sp)) break;
        }
        // Opening DOUBLE send-out: "X sent out A and B!" / "Go! A and B!" names both leads in
        // one banner. Split when BOTH halves resolve to real species (guards a nickname that
        // happens to contain "and") — resolveSpecies token-matches the pair to just one, so
        // we can't rely on species being null.
        const parts = msg.label.split(/\s+and\s+/i).map(s => s.trim()).filter(Boolean);
        if (parts.length === 2) {
          const r1 = matchSpecies(parts[0]!), r2 = matchSpecies(parts[1]!);
          if (r1 && r1.score >= 0.7 && r2 && r2.score >= 0.7) {
            this.roster[a] = r1.value; this.roster[b] = r2.value;
            this.actions.push({ actor: a, kind: 'switch', switchTo: r1.value });
            this.actions.push({ actor: b, kind: 'switch', switchTo: r2.value });
            break;
          }
        }
        const target: SlotRef = this.roster[a] == null ? a : this.roster[b] == null ? b : a;
        const species = msg.species ?? msg.label;          // null species → keep the label (nickname) as a tag
        this.roster[target] = species;
        this.actions.push({ actor: target, kind: 'switch', switchTo: species });
        break;
      }
      case 'switchOut': {
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (ref) this.roster[ref] = null;
        break;
      }
      case 'faint': {
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (ref) {
          if (this.faints.includes(ref)) break;            // re-fired faint banner
          this.attachTarget(msg.side, ref); this.faints.push(ref); this.roster[ref] = null;
        }
        else this.notes.push(`faint: unresolved ${msg.side} "${msg.label}"`);
        break;
      }
      case 'flinch':
      case 'effectiveness':
        this.attachTarget(msg.side, this.resolveSlot(msg.side, msg.species ?? msg.label));
        break;
      case 'protect': {
        // "X protected itself!" — X took no move damage this turn, so an HP dip on it
        // (residual chip) must NOT be read as a hit: exclude it from window-drop target
        // inference and spread detection. (Its own Protect action line is separate.)
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (ref) this.protectedThisTurn.add(ref);
        break;
      }
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
      const hit = cands.filter(r => this.roster[r] && (r === a.target || immDrop(r, i) >= 1));
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
      let pick = [f1, f2].filter(r => this.roster[r] && !this.protectedThisTurn.has(r) && immDrop(r, i) >= 3)  // 1. window drop
        .sort((x, y) => immDrop(y, i) - immDrop(x, i))[0];
      if (!pick) {
        const foes = [f1, f2].filter(r => !claimed.has(r));
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
        if (b.kind === 'move' && (b.target === ref || b.spread?.some(s => s.ref === ref))) return k;
      }
      return Number.MAX_SAFE_INTEGER;
    };
    this.actions.forEach((a, i) => {
      if (a.kind !== 'move') return;
      if (a.spread) {
        // A Protected ref took no damage — drop it from the spread list (its "hit"
        // would be a 0-damage observation). One survivor → plain single-target line.
        a.spread = a.spread.filter(s => !this.protectedThisTurn.has(s.ref));
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
        // Target Protected → keep the target (the move WAS aimed there — reveals the
        // move, feeds Choice-lock logic) but emit NO damage slot: an "unchanged HP"
        // value would read as a 0-damage observation and poison the spread inference.
        if (this.protectedThisTurn.has(a.target)) return;
        const smp = this.lastSample(a.target, i + 1, cutFor(i, a.target));
        const pct = smp?.pct ?? hpBySlot[a.target];
        if (pct != null) a.hpRemainingPercent = pct;
        if (smp?.raw != null) a.hpRemainingRaw = smp.raw;
      }
    });
    // Megas whose MOVE was never captured (missed banner) still happened → emit them as
    // standalone mega lines so the forme change isn't lost.
    const megas = [...this.megaPending];
    const obs: TurnObservation = { actions: this.actions, faints: this.faints, megas: megas.length ? megas : undefined, stateLines: this.stateLines.length ? [...this.stateLines] : undefined, confidence: 1, notes: this.notes };
    this.actions = []; this.faints = []; this.notes = []; this.stateLines = []; this.megaPending.clear(); this.hpSamples = {}; this.protectedThisTurn.clear();
    return obs;
  }

  /** Convenience: close the turn and emit its canonical turn-log lines. */
  endTurnLines(hpBySlot: Partial<Record<SlotRef, number>> = {}, hpBefore: Partial<Record<SlotRef, number>> = {}, touched?: Set<SlotRef>): string[] { return emitTurnLog(this.endTurn(hpBySlot, hpBefore, touched)); }
}
