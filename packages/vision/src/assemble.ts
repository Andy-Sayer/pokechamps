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
import type { SlotRef, TurnAction, TurnObservation } from './types.js';
import { emitTurnLog } from './turnLog.js';

export interface Roster { m1: string | null; m2: string | null; o1: string | null; o2: string | null; }

const slotsFor = (side: Side): [SlotRef, SlotRef] => (side === 'mine' ? ['m1', 'm2'] : ['o1', 'o2']);
const sideOf = (ref: SlotRef): Side => (ref[0] === 'm' ? 'mine' : 'opp');
const norm = (s: string | null): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export class BattleAssembler {
  private roster: Roster;
  private actions: TurnAction[] = [];
  private faints: SlotRef[] = [];
  private notes: string[] = [];
  private megaPending = new Set<SlotRef>();

  /** Seed the two leads per side (from the team-preview / nameplate appearance read). */
  constructor(leads: Partial<Roster> = {}) {
    this.roster = { m1: null, m2: null, o1: null, o2: null, ...leads };
  }

  /** Current active roster (slot → species), read-only snapshot. */
  getRoster(): Roster { return { ...this.roster }; }

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
        const ref = this.resolveSlot(msg.side, msg.species);
        if (ref) this.megaPending.add(ref);
        else this.notes.push(`mega: unresolved ${msg.side} "${msg.label}"`);
        break;
      }
      case 'move': {
        const ref = this.resolveSlot(msg.side, msg.species);
        if (!ref) { this.notes.push(`move: unresolved ${msg.side} "${msg.label}" (${msg.move})`); break; }
        const action: TurnAction = { actor: ref, kind: 'move', move: msg.move };
        if (this.megaPending.delete(ref)) action.mega = true;
        this.actions.push(action);
        break;
      }
      case 'switchIn': {
        const [a, b] = slotsFor(msg.side);
        const target: SlotRef = this.roster[a] == null ? a : this.roster[b] == null ? b : a;
        const species = msg.species ?? msg.label;          // null species → keep the label (nickname) as a tag
        this.roster[target] = species;
        this.actions.push({ actor: target, kind: 'switch', switchTo: species });
        break;
      }
      case 'switchOut': {
        const ref = this.resolveSlot(msg.side, msg.species);
        if (ref) this.roster[ref] = null;
        break;
      }
      case 'faint': {
        const ref = this.resolveSlot(msg.side, msg.species);
        if (ref) { this.attachTarget(msg.side, ref); this.faints.push(ref); this.roster[ref] = null; }
        else this.notes.push(`faint: unresolved ${msg.side} "${msg.label}"`);
        break;
      }
      case 'flinch':
      case 'effectiveness':
        this.attachTarget(msg.side, this.resolveSlot(msg.side, msg.species));
        break;
      // weather / statChange / heal / screen / megaReact / end → no turn-log action (yet)
      default: break;
    }
  }

  /** Close the current turn → its TurnObservation, and reset for the next. Pass the
   *  post-turn remaining HP% per slot (from the HP read, opp nameplate %, mine
   *  abs/max) to fill each damaging move's `hpRemainingPercent` — that's the damage
   *  signal the inference solver back-solves spreads from. One read/slot per turn
   *  assumes one hit/target/turn (the common case); refine with mid-turn reads. */
  endTurn(hpBySlot: Partial<Record<SlotRef, number>> = {}): TurnObservation {
    for (const a of this.actions) {
      if (a.kind === 'move' && a.target != null && hpBySlot[a.target] != null) a.hpRemainingPercent = hpBySlot[a.target];
    }
    const obs: TurnObservation = { actions: this.actions, faints: this.faints, confidence: 1, notes: this.notes };
    this.actions = []; this.faints = []; this.notes = []; this.megaPending.clear();
    return obs;
  }

  /** Convenience: close the turn and emit its canonical turn-log lines. */
  endTurnLines(hpBySlot: Partial<Record<SlotRef, number>> = {}): string[] { return emitTurnLog(this.endTurn(hpBySlot)); }
}
