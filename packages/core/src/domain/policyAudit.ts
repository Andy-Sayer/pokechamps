/**
 * policyAudit.ts — pressure-test the fast search's RECOMMENDED MOVE against
 * @pkmn/sim ground truth. Distinct from `simDiff.ts`, which audits the
 * transition MODEL (does `resolveOneTurn` match the sim given the same moves);
 * this audits the POLICY (does the search pick my best move).
 *
 * Two stages, so the flags are both cheap to find and trustworthy:
 *   1. SWEEP (opp held at the search's predicted reply): vary one of my mons'
 *      moves, resolve each through the real engine, nominate any that beats the
 *      search's pick. Cheap but biased — an alternative is judged against a reply
 *      tuned to punish a DIFFERENT move, so it over-nominates.
 *   2. CONFIRM (opp best-responds): for the nominees only, let the opponent
 *      minimise my material by enumerating its replies. The regret that survives
 *      is a true one-ply maximin regret — the search failed to best-respond.
 *
 * Outcomes are scored with an INDEPENDENT material metric (HP diff + faint
 * tempo), deliberately NOT the search's own `leafScore`, so a value-function bug
 * can't hide. Flags are classified because a one-ply audit can't see deeper
 * lines: `mispick` (attack→better attack — the clearest bug) and `stall-by-search`
 * (search stalled when attacking was better) are real; `stall-positive` (a
 * Protect beats the search's attack) is usually a depth-1 artifact (Protect takes
 * 0 damage but makes no progress — the search sees deeper) and is reported apart.
 */
import { runExactOracle, type OracleSuccess, type OracleLine } from './simOracle.js';
import type { SearchInput, SearchResult, SearchPlay } from './endgameSearch.js';
import { getMove, toId } from './data.js';

/** A faint is worth more than the HP it removes — it costs the foe a whole turn
 *  of tempo. Added on top of the HP-sum difference (HP is already 0 on a faint). */
const FAINT_TEMPO = 50;
/** Cap on enumerated opponent joint replies in the confirm stage (2 actives ×
 *  ~5 plays = ~25 typically; the cap only bites on unusually wide boards). */
const OPP_JOINT_CAP = 60;

/** Independent material value of a resolved turn, in HP-percent points (higher =
 *  better for me). Sums mean post-turn HP over seeds for every active mon, plus a
 *  tempo bonus per net faint. Bench mons aren't in the oracle output but are
 *  identical across the alternatives being compared, so they cancel. */
export function material(r: OracleSuccess): number {
  let myHp = 0, oppHp = 0, myFaint = 0, oppFaint = 0;
  for (const m of r.mons) {
    if (m.side === 'mine') { myHp += m.hpMean; myFaint += m.faintRate; }
    else { oppHp += m.hpMean; oppFaint += m.faintRate; }
  }
  return (myHp - oppHp) + FAINT_TEMPO * (oppFaint - myFaint);
}

/** Every move a mon could make this turn, as SearchPlays the oracle can map:
 *  single-target moves fan out over the live foes; spread/self/field moves get
 *  one play. Switches are out of scope (this audits move choice). */
export function candidatePlays(species: string, moves: string[], liveFoes: string[], ally: string): SearchPlay[] {
  const out: SearchPlay[] = [];
  const seen = new Set<string>();
  const push = (p: SearchPlay) => { const k = `${toId(p.move)}|${toId(p.targetSpecies)}|${p.spread ? 's' : ''}|${p.self ? 'f' : ''}`; if (!seen.has(k)) { seen.add(k); out.push(p); } };
  for (const move of moves) {
    if (!move) continue;
    const tgt = (getMove(move) as { target?: string } | undefined)?.target ?? 'normal';
    if (tgt === 'allAdjacentFoes' || tgt === 'allAdjacent') push({ mySpecies: species, move, targetSpecies: '', spread: true });
    else if (tgt === 'normal' || tgt === 'any' || tgt === 'adjacentFoe') {
      for (const foe of liveFoes) push({ mySpecies: species, move, targetSpecies: foe });
    } else if (tgt === 'adjacentAlly') {
      if (ally) push({ mySpecies: species, move, targetSpecies: ally });
    } else {
      push({ mySpecies: species, move, targetSpecies: species, self: true });
    }
  }
  return out;
}

// A move with no immediate damage (Tailwind, Protect, screens, weather, status,
// any setup): its value at the one-turn horizon is ~0, so the material metric
// can't see its payoff. A flag involving one is a depth-1 artifact, not a bug —
// the search's depth is exactly the edge the audit is blind to here.
const isSetup = (p: SearchPlay): boolean => p.self === true || (getMove(p.move) as { category?: string } | undefined)?.category === 'Status';
function playLabel(p: SearchPlay): string {
  if (p.switch) return `switch → ${p.targetSpecies}`;
  if (p.spread) return `${p.move} (spread)`;
  if (p.self) return p.move;
  return `${p.move} → ${p.targetSpecies}`;
}

/** Sim material of MY joint line against ONE held opponent line. null when the
 *  oracle can't resolve it (board the sim can't load, an unmappable/illegal
 *  play, a Champions custom mega…). */
async function lineValue(input: SearchInput, plays: SearchPlay[], oppLine: SearchPlay[] | undefined, megaMon: string | undefined, seeds: number): Promise<{ value: number } | { error: string }> {
  const line: OracleLine = { plays, oppLine, megaMon };
  const r = await runExactOracle(input, line, { seeds });
  return r.ok ? { value: material(r as OracleSuccess) } : { error: r.error };
}

/** My line's value when the OPPONENT best-responds: enumerate the opp's joint
 *  replies and take the min material (opp minimises my outcome). null when no
 *  reply resolves. */
async function oppBestResponseValue(input: SearchInput, myLine: SearchPlay[], oppActives: { sp: string; moves: string[] }[], myActiveSpecies: string[], megaMon: string | undefined, seeds: number): Promise<number | null> {
  const perMon = oppActives.map((o, k) => candidatePlays(o.sp, o.moves, myActiveSpecies, oppActives[1 - k]?.sp ?? ''));
  const joints: SearchPlay[][] = [];
  if (perMon.length === 1) for (const a of perMon[0]!) joints.push([a]);
  else for (const a of perMon[0]!) for (const b of perMon[1]!) { if (joints.length < OPP_JOINT_CAP) joints.push([a, b]); }
  let min = Infinity;
  for (const oj of joints) {
    const r = await runExactOracle(input, { plays: myLine, oppLine: oj, megaMon }, { seeds });
    if (r.ok) min = Math.min(min, material(r as OracleSuccess));
  }
  return Number.isFinite(min) ? min : null;
}

export type RegretKind = 'mispick' | 'setup-by-search' | 'stall-positive';
export interface MoveRegret {
  mon: string;
  kind: RegretKind;
  searchPlay: string;
  bestPlay: string;
  /** Stage-1 (opp held) regret, for transparency. */
  sweepRegret: number;
  /** Stage-2 (opp best-responds) confirmed regret — the trustworthy number. */
  regret: number;
  searchValue: number;
  bestValue: number;
}

export interface PositionAudit {
  label: string;
  searchDepth: number;
  searchScore: number;
  skipReason?: string;
  regrets: MoveRegret[];
}

export interface AuditOpts {
  seeds?: number;
  /** Flag a mon only when the CONFIRMED regret is ≥ this many material points
   *  (HP-percent). Default 25 (~a quarter of a mon). */
  flagThreshold?: number;
}

function classify(searchPlay: SearchPlay, bestPlay: SearchPlay): RegretKind {
  const s = isSetup(searchPlay), b = isSetup(bestPlay);
  if (!s && !b) return 'mispick';          // attack vs a better attack — the only real-bug signal
  if (s && !b) return 'setup-by-search';   // search set up; an attack scores better THIS turn (depth-1 blind to the payoff)
  return 'stall-positive';                 // the better alternative is itself a setup/Protect move (depth-1 artifact)
}

/** Audit one position: search's pick vs the sim-optimal move for each of my
 *  active mons, two-stage (sweep → confirm). */
export async function auditPosition(input: SearchInput, result: SearchResult, label: string, opts: AuditOpts = {}): Promise<PositionAudit> {
  const seeds = opts.seeds ?? 12;
  const flag = opts.flagThreshold ?? 25;
  const out: PositionAudit = { label, searchDepth: result.depth, searchScore: Math.round(result.score), regrets: [] };

  const myActive = input.mine.map((m, i) => ({ i, sp: m.set.species, active: m.active && m.hpPercent > 0 })).filter(m => m.active);
  const oppActives = input.opp.filter(o => o.active && o.hpPercent > 0).map(o => ({ sp: o.entry.species, moves: o.entry.knownMoves ?? o.entry.candidates?.[0]?.moves ?? [] }));
  const myActiveSpecies = myActive.map(m => m.sp);
  const foeActive = oppActives.map(o => o.sp);
  const playOf = (sp: string) => result.plays.find(p => toId(p.mySpecies) === toId(sp));

  for (const { i, sp } of myActive) {
    const partnerSp = myActive.find(a => a.i !== i)?.sp;
    const partnerPlay = partnerSp ? playOf(partnerSp) : undefined;
    const searchPlay = playOf(sp);
    if (!searchPlay) continue;
    const fixed = (mine: SearchPlay) => [mine, partnerPlay].filter((p): p is SearchPlay => !!p);

    // --- Stage 1: sweep (opp held at the search's predicted reply) ----------
    const sv = await lineValue(input, fixed(searchPlay), result.oppLine, result.megaMon, seeds);
    if ('error' in sv) { out.skipReason = out.skipReason ?? sv.error; continue; }
    const sameAsSearch = (c: SearchPlay) => toId(c.move) === toId(searchPlay.move) && toId(c.targetSpecies) === toId(searchPlay.targetSpecies) && !!c.spread === !!searchPlay.spread;
    const scored: { play: SearchPlay; value: number }[] = [];
    for (const cand of candidatePlays(sp, input.mine[i]!.set.moves ?? [], foeActive, partnerSp ?? '')) {
      if (sameAsSearch(cand)) continue;
      const r = await lineValue(input, fixed(cand), result.oppLine, result.megaMon, seeds);
      if ('value' in r) scored.push({ play: cand, value: r.value });
    }
    // Nominate the alternatives that beat the search's pick under the held opp.
    const nominees = scored.filter(c => c.value - sv.value >= flag).sort((a, b) => b.value - a.value).slice(0, 3);
    if (!nominees.length) continue;
    const sweepRegret = Math.round(nominees[0]!.value - sv.value);

    // --- Stage 2: confirm (opp best-responds) -------------------------------
    const searchConfirmed = await oppBestResponseValue(input, fixed(searchPlay), oppActives, myActiveSpecies, result.megaMon, seeds);
    if (searchConfirmed == null) continue;
    let best: { play: SearchPlay; value: number } = { play: searchPlay, value: searchConfirmed };
    for (const n of nominees) {
      const v = await oppBestResponseValue(input, fixed(n.play), oppActives, myActiveSpecies, result.megaMon, seeds);
      if (v != null && v > best.value) best = { play: n.play, value: v };
    }
    const regret = best.value - searchConfirmed;
    if (regret >= flag) {
      out.regrets.push({
        mon: sp, kind: classify(searchPlay, best.play),
        searchPlay: playLabel(searchPlay), bestPlay: playLabel(best.play),
        sweepRegret, regret: Math.round(regret),
        searchValue: Math.round(searchConfirmed), bestValue: Math.round(best.value),
      });
    }
  }
  out.regrets.sort((a, b) => b.regret - a.regret);
  return out;
}
