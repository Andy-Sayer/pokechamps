import type { Gimmick } from './types.js';

// Z-Moves (Gen 7 / older formats). Activating turns the chosen move into its
// Z-Move variant for one use per battle. @smogon/calc accepts `useZ: true`
// on Move opts.
//
// No team-time data needed — the Z-Crystal item is what unlocks the Z-Move
// at battle time, and the user picks which move to upgrade via the
// activation control.
export const zmoveGimmick: Gimmick = {
  id: 'zmove',
  label: 'Z-Move',

  enrichCalcMove({ active, opts }) {
    if (active) opts.useZ = true;
  },

  battleControl(_set, active) {
    if (active) return null;
    return { hotkey: 'z', label: 'Use Z-Move (one per battle)' };
  },
};
