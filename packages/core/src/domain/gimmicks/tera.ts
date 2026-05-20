import type { Gimmick } from './types.js';

// Terastallization (Reg G+ formats). Each mon picks a Tera Type at team-build
// time; activating it in battle changes their type to the chosen one for
// damage calc purposes. @smogon/calc accepts `teraType` (string) + `isTera`
// (boolean) on Pokemon.
//
// One per battle is the typical allowance — `gimmickAllowancePerSide` in the
// format file controls that limit at the BattleScreen level.
export const teraGimmick: Gimmick = {
  id: 'tera',
  label: 'Terastallization',

  parseShowdownLine(line, draft) {
    const m = line.match(/^Tera Type:\s*(\S+)/i);
    if (!m) return false;
    draft.teraType = m[1];
    return true;
  },

  formatShowdownLines(set) {
    return set.teraType ? [`Tera Type: ${set.teraType}`] : [];
  },

  enrichCalcPokemon({ set, active, opts }) {
    if (!set.teraType) return;
    opts.teraType = set.teraType;
    if (active) opts.isTera = true;
  },

  battleControl(set, active) {
    if (active) return null;
    if (!set.teraType) return null;
    return { hotkey: 't', label: `Terastallize → ${set.teraType}` };
  },

  describeSet(set) {
    return set.teraType ? `Tera: ${set.teraType}` : null;
  },
};
