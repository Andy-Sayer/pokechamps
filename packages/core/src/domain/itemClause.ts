import type { OpponentEntry } from './types.js';
import { toId } from './data.js';

// Item Clause (Regulation Set M-A): no two members of a team may hold the same
// item. So once an opponent mon's item is KNOWN — currently held (`item`) or
// observed consumed (`itemConsumed`) — that item is spoken for and cannot appear
// on any OTHER opponent mon. This prunes the claimed item from every other mon's
// candidate item pool, keeping candidateLikelihoods aligned.
//
// Guards:
//  - "No item" (empty-string item) claims nothing — multiple mons may hold none.
//  - Never empties a candidate set: if every candidate would be ruled out (e.g.
//    a mislogged duplicate item), the set is left intact rather than vanishing.
//  - Operates in place on the passed array's entries; returns human-readable
//    notes for the inference log.
export function applyItemClauseExclusion(opponentTeam: OpponentEntry[]): string[] {
  const notes: string[] = [];
  // The specific item id each mon has claimed (a held item wins over a consumed
  // one). null = nothing claimed (unknown or explicitly no item).
  const claimedBy = opponentTeam.map(o => {
    const held = o.item && o.item.trim() ? o.item : undefined;
    const it = held ?? o.itemConsumed;
    return it && it.trim() ? toId(it) : null;
  });
  opponentTeam.forEach((o, idx) => {
    if (!o.candidates?.length) return;
    const exclude = new Set<string>();
    claimedBy.forEach((cid, j) => { if (j !== idx && cid) exclude.add(cid); });
    if (!exclude.size) return;
    const keep: number[] = [];
    o.candidates.forEach((c, i) => { if (!exclude.has(toId(c.item ?? ''))) keep.push(i); });
    if (keep.length && keep.length < o.candidates.length) {
      const dropped = o.candidates.length - keep.length;
      o.candidates = keep.map(i => o.candidates![i]!);
      if (o.candidateLikelihoods) o.candidateLikelihoods = keep.map(i => o.candidateLikelihoods![i]!);
      notes.push(`o${idx + 1}: ${dropped} spread(s) ruled out by item clause`);
    }
  });
  return notes;
}
