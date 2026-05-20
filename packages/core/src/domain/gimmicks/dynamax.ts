import type { Gimmick } from './types.js';

// Dynamax / Gigantamax (Gen 8). Activating doubles the mon's HP and converts
// moves to their Max variants. Lasts 3 turns. @smogon/calc accepts
// `isDynamaxed: true` (and `dynamaxLevel` for HP scaling) on Pokemon, and
// `useMax: true` on Move opts.
//
// The 3-turn timer + per-side allowance lives in the BattleScreen (see
// existing mega allowance pattern). This module just bridges to the calc.
export const dynamaxGimmick: Gimmick = {
  id: 'dynamax',
  label: 'Dynamax',

  enrichCalcPokemon({ active, opts }) {
    if (active) {
      opts.isDynamaxed = true;
      opts.dynamaxLevel = 10;
    }
  },

  enrichCalcMove({ active, opts }) {
    if (active) opts.useMax = true;
  },

  battleControl(_set, active) {
    if (active) return null;
    return { hotkey: 'x', label: 'Dynamax (one per battle, 3 turns)' };
  },
};
