import type { FrameRead, TurnObservation } from './types.js';

/** A doubles turn flows: move-select → animations → battle-text lines → HP settles.
 *  The machine watches the battle-text region for action/faint sentences and the
 *  HP bars for deltas, debouncing until HP is stable + the log box is quiet, then
 *  emits one TurnObservation. */
export type Phase = 'idle' | 'selecting' | 'resolving' | 'settled';

export class BattleStateMachine {
  private phase: Phase = 'idle';
  private reads: FrameRead[] = [];

  /** Feed a per-frame read; returns a TurnObservation when a turn completes, else
   *  null. The phase transitions need live capture timing to tune (when is HP
   *  "stable"? how long is the text box "quiet"?), so the body is intentionally a
   *  skeleton — the OUTPUT type + the emit boundary are what's pinned now. */
  feed(read: FrameRead): TurnObservation | null {
    this.reads.push(read);
    // TODO(impl, needs live frames):
    //  1. parse read.battleText → actions ("X used Y") + faints ("X fainted")
    //     (reuse fuzzyMatch for the species/move tokens);
    //  2. diff hpFraction across reads → each target's settled remaining HP%;
    //  3. detect mega ("X Mega Evolved!") / crit ("critical hit!") / switch lines;
    //  4. debounce: only emit once HP bars stop changing AND the text box clears.
    return null;
  }

  /** Drop accumulated frames (e.g. after the user confirms a turn). */
  reset(): void { this.phase = 'idle'; this.reads = []; }
}
