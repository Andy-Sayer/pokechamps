import type { OpponentEntry, PokemonSet } from '../domain/types.js';
import type { BringScore } from '../domain/bring.js';
import type { SpreadCandidate } from '../domain/inference.js';
import { activeGimmick } from '../domain/gimmicks/index.js';
import { ask } from './client.js';

const SYSTEM = `You are a Pokemon VGC / Pokemon Champions doubles analyst. You think tersely in competitive vocabulary: speed tiers, win conditions, lead pairs, threat coverage, BO1 risk. You never invent moves, items, or mechanics — only reason about what is in the provided context. Output 4-8 short sentences unless asked otherwise.`;

function formatSet(s: PokemonSet): string {
  const evs = Object.entries(s.evs).filter(([_,v]) => v).map(([k,v]) => `${v} ${k.toUpperCase()}`).join(' / ') || 'none';
  const gimmickNote = activeGimmick().describeSet?.(s);
  const tail = gimmickNote ? ` | ${gimmickNote}` : '';
  return `${s.species} @ ${s.item ?? '(no item)'} | ${s.ability ?? '?'} | ${s.nature} | EVs ${evs} | ${s.moves.join(', ')}${tail}`;
}

function formatOpp(o: OpponentEntry): string {
  return `${o.species}${o.item ? ` @ ${o.item}` : ''}${o.ability ? ` (${o.ability})` : ''} | known moves: ${o.knownMoves.join(', ') || 'none'}`;
}

export async function explainBring(args: {
  myTeam: PokemonSet[];
  opponent: OpponentEntry[];
  topBrings: BringScore[];
}): Promise<string> {
  const ctx = `MY TEAM:\n${args.myTeam.map((s, i) => `${i}. ${formatSet(s)}`).join('\n')}\n\nOPPONENT:\n${args.opponent.map((o, i) => `${i}. ${formatOpp(o)}`).join('\n')}`;
  const top = args.topBrings.slice(0, 3).map((b, i) => {
    const mons = b.myIndices.map(idx => args.myTeam[idx]!.species).join(' + ');
    return `${i + 1}. ${mons}  (offense ${b.offense}, defense ${b.defense}, speed ${b.speed}, roles ${b.roles})`;
  }).join('\n');
  const user = `Heuristic top 3 brings:\n${top}\n\nPick the best of the three. Briefly justify the lead pair, the likely opposing lead, and the biggest threat we need a plan for. If the heuristic is wrong, say so and recommend an alternative.`;
  return ask({ system: SYSTEM, cachedContext: ctx, user });
}

export async function reviewLastTurn(args: {
  myTeam: PokemonSet[];
  opponent: OpponentEntry[];
  lastTurn: { index: number; actions: Array<{ side: string; move: string; target?: unknown; damageHpPercent?: number; targetRemainingHpPercent?: number; targetRemainingHpRaw?: number }>; };
  activeSummary: string;
  fieldSummary: string;
}): Promise<string> {
  const ctx = `MY TEAM:\n${args.myTeam.map((s, i) => `${i}. ${formatSet(s)}`).join('\n')}\n\nOPPONENT:\n${args.opponent.map((o, i) => `${i}. ${formatOpp(o)}`).join('\n')}`;
  const acts = args.lastTurn.actions.map((a, i) => `  ${i + 1}. ${a.side} ${a.move}${a.damageHpPercent != null ? ` → ${a.damageHpPercent.toFixed(0)}% dealt` : ''}`).join('\n');
  const user = `Turn ${args.lastTurn.index} just resolved:\n${acts}\n\nActive: ${args.activeSummary}\nField: ${args.fieldSummary}\n\nIn 3-5 sentences: what was the key exchange, what did we learn about the opponent (item/ability/EV signals), and what's the immediate threat to plan around next turn? Don't recommend specific moves — just describe the state.`;
  return ask({ system: SYSTEM, cachedContext: ctx, user });
}

export async function narrateInference(args: {
  defenderSpecies: string;
  beforeCount: number;
  afterCount: number;
  topCandidates: SpreadCandidate[];
  observationSummary: string;
}): Promise<string> {
  const top = args.topCandidates.slice(0, 5).map((c, i) => {
    const evs = Object.entries(c.evs).filter(([_, v]) => v).map(([k, v]) => `${v}${k.toUpperCase()}`).join('/');
    return `${i + 1}. ${c.nature} ${evs || 'no investment'}${c.item ? ` @ ${c.item}` : ''}`;
  }).join('\n');
  const user = `Defender: ${args.defenderSpecies}\nObservation: ${args.observationSummary}\nCandidates narrowed from ${args.beforeCount} -> ${args.afterCount}.\nTop remaining spreads:\n${top}\n\nWhat does this tell us about how the opponent built this Pokemon, and what should we expect from it next? 2-3 sentences.`;
  return ask({ system: SYSTEM, user });
}
