// Apply a /mega action to a Match. Resolves the action's variant
// ('mega' / 'mega-x' / 'mega-y' / etc.) into a concrete forme + stone:
//
//   1. If a held mega stone is already known → use it (most precise).
//   2. Else if a variant suffix was supplied (x/y/z) → look up by variant.
//   3. Else if exactly one LEGAL stone exists for this species → use it.
//   4. Else error.
//
// On success:
//   - flips megaUsed (opp) or appends to myMegaUsed (mine)
//   - records the resolved forme on megaForme / myMegaForme
//   - confirms opp.item to the mega stone (opp side only — mine side's
//     item is already known from the team data)
//
// Returns an error string when ambiguous; nothing is mutated.
import type { Match, MoveAction, PokemonSet } from './types.js';
import { getMegaOptions, resolveMegaForme, type MegaOption } from './gimmicks/mega.js';
import { isLegalItem, toId, getSpecies } from './data.js';

function pickOption(
  speciesName: string,
  variant: string,
  heldItem: string | null | undefined,
): { option: MegaOption | null; error: string | null } {
  const all = getMegaOptions(speciesName);
  if (all.length === 0) return { option: null, error: `${speciesName} can't mega-evolve.` };

  // 1. Held stone locks the forme — no guessing needed.
  if (heldItem) {
    const heldId = toId(heldItem);
    const byItem = all.find(o => toId(o.stone) === heldId);
    if (byItem) return { option: byItem, error: null };
  }

  // 2. Explicit variant suffix from the parser ("mega x" / "mega y").
  if (variant) {
    const byVariant = resolveMegaForme(speciesName, variant);
    if (byVariant) return { option: byVariant, error: null };
    const have = all.map(o => o.variant || '(default)').join('/');
    return { option: null, error: `${speciesName} has no "${variant}" mega — available variants: ${have}` };
  }

  // 3. Filter to format-legal options. Often only one variant is allowed
  // in a given regulation set (e.g. Reg M-A bans the Z variants), so the
  // user can just say "mega" without a suffix.
  const legal = all.filter(o => isLegalItem(o.stone));
  if (legal.length === 1) return { option: legal[0]!, error: null };
  if (legal.length === 0 && all.length === 1) return { option: all[0]!, error: null };

  // 4. Still ambiguous.
  const pool = legal.length > 0 ? legal : all;
  const variants = pool.map(o => o.variant || '(default)').join('/');
  return {
    option: null,
    error: `${speciesName} has multiple mega formes — disambiguate, e.g. "mega ${pool[0]!.variant || 'y'}" (available: ${variants})`,
  };
}

export function applyMegaAction(match: Match, a: MoveAction): string | null {
  if (a.kind !== 'mega' || a.attackerTeamIndex == null) return null;

  // Variant carried on the action's move field as 'mega', 'mega-x', 'mega-y'.
  const variant = a.move.toLowerCase().startsWith('mega-')
    ? a.move.slice(5)
    : '';

  if (a.side === 'mine') {
    const idx = a.attackerTeamIndex;
    const set = match.myTeam[idx];
    if (!set) return null;
    const { option, error } = pickOption(set.species, variant, set.item);
    if (!option) return error;
    const list = match.myMegaUsed ? [...match.myMegaUsed] : [];
    if (!list.includes(idx)) list.push(idx);
    match.myMegaUsed = list;
    match.myMegaForme = { ...(match.myMegaForme ?? {}), [idx]: option.forme };
    return null;
  }

  const idx = a.attackerTeamIndex;
  const opp = match.opponentTeam[idx];
  if (!opp) return null;
  const { option, error } = pickOption(opp.species, variant, opp.item);
  if (!option) return error;
  opp.megaUsed = true;
  opp.megaForme = option.forme;
  // Mega activation CONFIRMS the held item — we now know it's the stone
  // that matches this forme. Set the item field (mega stones aren't
  // consumed; they stay equipped, so no itemConsumed update).
  opp.item = option.stone;
  // Retain the candidate stat-point spreads we've inferred so far, but
  // remap each candidate's species/item/ability to the mega forme so
  // downstream calcs use the right base stats + ability. EVs / nature /
  // IVs / moves are preserved unchanged — those are the SP allocations
  // the user has narrowed via observation and they stay valid across
  // the mega transformation.
  if (opp.candidates && opp.candidates.length > 0) {
    const megaAbility = megaFormeAbility(option.forme);
    opp.candidates = opp.candidates.map<PokemonSet>(c => ({
      ...c,
      species: option.forme,
      item: option.stone,
      ability: megaAbility ?? c.ability,
    }));
  }
  return null;
}

// Mega formes have a single ability slot in the dex (`abilities['0']`).
// Returns undefined if the dex lookup fails — caller falls back to the
// candidate's existing ability so we don't accidentally wipe it.
function megaFormeAbility(formeName: string): string | undefined {
  const sp = getSpecies(formeName) as any;
  const abilities = sp?.abilities as Record<string, string> | undefined;
  return abilities?.['0'];
}
