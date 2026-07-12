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

export class BattleAssembler {
  private roster: Roster;
  private actions: TurnAction[] = [];
  private faints: SlotRef[] = [];
  private notes: string[] = [];
  private stateLines: string[] = [];    // stat-boost lines (Intimidate, Nasty Plot, …) this turn
  private megaPending = new Set<SlotRef>();

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
      if (a.kind === 'move' && a.target == null && sideOf(a.actor) !== side) return a;
    }
    return undefined;
  }

  /** A follow-up line (flinch/effectiveness/faint) names who a move hit → pin target. */
  private attachTarget(side: Side, ref: SlotRef | null): void {
    if (!ref) return;
    const a = this.lastMoveInto(side);
    if (a) a.target = ref;
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
        const action: TurnAction = { actor: ref, kind: 'move', move: msg.move };
        if (this.megaPending.delete(ref)) action.mega = true;
        this.actions.push(action);
        break;
      }
      case 'switchIn': {
        const [a, b] = slotsFor(msg.side);
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
        if (ref) { this.attachTarget(msg.side, ref); this.faints.push(ref); this.roster[ref] = null; }
        else this.notes.push(`faint: unresolved ${msg.side} "${msg.label}"`);
        break;
      }
      case 'flinch':
      case 'effectiveness':
        this.attachTarget(msg.side, this.resolveSlot(msg.side, msg.species ?? msg.label));
        break;
      case 'statChange': {
        // Stat boosts (Intimidate on switch-in, Nasty Plot, etc.) → a turn-log state line
        // `o1 -1 atk`. This is why the initial Intimidate was vanishing — it was dropped here.
        const ref = this.resolveSlot(msg.side, msg.species ?? msg.label);
        if (!ref) { this.notes.push(`statChange unresolved ${msg.side} "${msg.label}"`); break; }
        const sign = msg.dir === 'rose' ? '+' : '-';
        const MAP: Record<string, string> = { attack: 'atk', defense: 'def', 'sp. atk': 'spa', 'sp. def': 'spd', speed: 'spe', accuracy: 'acc', evasiveness: 'eva' };
        const parts = msg.stats.map(s => MAP[s.toLowerCase()]).filter(Boolean).map(st => `${sign}${msg.magnitude} ${st}`);
        if (parts.length) this.stateLines.push(`${ref} ${parts.join(' ')}`);
        break;
      }
      case 'weatherStart': {
        // Drizzle/Rain Dance/etc. — set the field weather so damage calcs reflect it. bannerParse
        // gives 'rain'|'sandstorm'|'sun'|'snow'; the turn-log wants rain|sand|sun|snow.
        const MAP: Record<string, string> = { rain: 'rain', sandstorm: 'sand', sun: 'sun', snow: 'snow' };
        const w = MAP[msg.weather];
        if (w) this.stateLines.push(`weather ${w}`);
        break;
      }
      case 'weatherEnd':
        this.stateLines.push('weather clear');
        break;
      // heal / screen / megaReact / end → no turn-log action (yet)
      default: break;
    }
  }

  /** Close the current turn → its TurnObservation, and reset for the next. Pass the
   *  post-turn remaining HP% per slot (from the HP read, opp nameplate %, mine
   *  abs/max) to fill each damaging move's `hpRemainingPercent` — that's the damage
   *  signal the inference solver back-solves spreads from. One read/slot per turn
   *  assumes one hit/target/turn (the common case); refine with mid-turn reads. */
  endTurn(hpBySlot: Partial<Record<SlotRef, number>> = {}, hpBefore: Partial<Record<SlotRef, number>> = {}, touched?: Set<SlotRef>): TurnObservation {
    // TARGET INFERENCE for moves the banner didn't name (neutral single hits emit no
    // "effective on X" line). Priority, per the HUD's behaviour:
    //   1. the foe whose NAMEPLATE APPEARED this turn — only affected mons show a plate, so
    //      a foe plate = the mon that was hit (the strongest signal).
    //   2. else the foe whose settled HP fell most.
    //   3. else, for an OFFENSIVE move, the first live foe (never "self").
    // Status/self moves touch no foe + drop no foe HP → stay untargeted (correctly "self").
    const claimed = new Set<SlotRef>();
    const dropOf = (ref: SlotRef): number => { const after = hpBySlot[ref]; return after == null ? 0 : Math.max(0, (hpBefore[ref] ?? 100) - after); };
    for (const a of this.actions) {
      // Only OFFENSIVE moves get a foe target inferred — a status/self move (Light Screen,
      // Tailwind, Protect, Swords Dance) touches no foe, so it stays "self" even if a foe's
      // plate appeared this turn from a DIFFERENT move.
      if (a.kind !== 'move' || a.target != null || !isOffensive(a.move)) continue;
      const [f1, f2] = slotsFor(sideOf(a.actor) === 'mine' ? 'opp' : 'mine');
      const foes = [f1, f2].filter(r => !claimed.has(r));
      let pick = foes.find(r => touched?.has(r) && this.roster[r]);                          // 1. plate appeared
      if (!pick) pick = foes.filter(r => dropOf(r) >= 3).sort((x, y) => dropOf(y) - dropOf(x))[0]; // 2. HP fell
      if (!pick) {                                                                            // 3. default to a live foe
        pick = foes.find(r => this.roster[r]) ?? f1;
        this.notes.push(`target defaulted (offensive, no plate/HP signal): ${a.move}→${pick}`);
      }
      if (pick) { a.target = pick; claimed.add(pick); }
    }
    for (const a of this.actions) {
      if (a.kind === 'move' && a.target != null && hpBySlot[a.target] != null) a.hpRemainingPercent = hpBySlot[a.target];
    }
    // Megas whose MOVE was never captured (missed banner) still happened → emit them as
    // standalone mega lines so the forme change isn't lost.
    const megas = [...this.megaPending];
    const obs: TurnObservation = { actions: this.actions, faints: this.faints, megas: megas.length ? megas : undefined, stateLines: this.stateLines.length ? [...this.stateLines] : undefined, confidence: 1, notes: this.notes };
    this.actions = []; this.faints = []; this.notes = []; this.stateLines = []; this.megaPending.clear();
    return obs;
  }

  /** Convenience: close the turn and emit its canonical turn-log lines. */
  endTurnLines(hpBySlot: Partial<Record<SlotRef, number>> = {}, hpBefore: Partial<Record<SlotRef, number>> = {}, touched?: Set<SlotRef>): string[] { return emitTurnLog(this.endTurn(hpBySlot, hpBefore, touched)); }
}
