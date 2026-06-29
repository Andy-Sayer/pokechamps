// Robust bring recommendation (idea 5: opponent-bring prior). Instead of assuming
// the opponent brings one fixed set of 4, evaluate OUR bring against the opponent's
// top-K LIKELY brings and take the MAXIMIN (worst case) — so the pick is robust to
// which four they actually bring. Propose→dispose: the value model shortlists our
// brings (fast), the simulator plays each shortlisted bring vs the opponent's
// candidate brings (trustworthy). Reused by recommend-bring + the prep-sheet gen.
import { scoreBrings } from './bring.js';
import { entryOf } from './teamSim.js';
import { bringWinProb, bringModelAvailable } from './bringValueModel.js';
import { PlayoutPool, bringWinRate } from './playoutPool.js';
import type { PokemonSet } from './types.js';

/** All C(6,4)=15 brings as index tuples. */
export function allBrings(): number[][] {
  const out: number[][] = [];
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) for (let d = c + 1; d < 6; d++) out.push([a, b, c, d]);
  return out;
}

export interface BringRec {
  bring: PokemonSet[];
  /** Worst-case win-rate over the opponent's candidate brings (what we maximize). */
  maximinWr: number;
  /** This bring's win-rate vs each opponent candidate bring. */
  perOppBring: { oppBring: PokemonSet[]; wr: number }[];
  /** The opponent's candidate brings we evaluated against. */
  oppBrings: PokemonSet[][];
  /** Shortlist actually simulated, with the model's prior (for transparency). */
  shortlist: { bring: PokemonSet[]; modelP: number; maximinWr: number }[];
}

/** Best bring for `myTeam` vs `oppSets`, robust over the opponent's top-`oppBringK`
 *  brings. The model proposes `myBringK` of our brings; the sim disposes (maximin). */
export async function bestBringVsOpponent(
  pool: PlayoutPool, myTeam: PokemonSet[], oppSets: PokemonSet[],
  opts: { myBringK?: number; oppBringK?: number; games?: number } = {},
): Promise<BringRec> {
  const myBringK = opts.myBringK ?? 5, oppBringK = opts.oppBringK ?? 2, games = opts.games ?? 8;
  const myEntries = myTeam.map(entryOf);
  const combos = allBrings();

  // The opponent's candidate brings: their heuristic top-K vs our full team.
  const oppBrings = scoreBrings(oppSets, myEntries).slice(0, oppBringK).map(b => b.myIndices.map(i => oppSets[i]!));
  const refOpp = oppBrings[0]!; // model features are computed vs their most-likely bring

  // PROPOSE: rank our brings — by the value model if present, else the scoreBrings order.
  let ordered: { bring: PokemonSet[]; modelP: number }[];
  if (bringModelAvailable()) {
    ordered = combos.map(c => ({ bring: c.map(i => myTeam[i]!), modelP: bringWinProb(c.map(i => myTeam[i]!), refOpp) ?? 0 }))
      .sort((a, b) => b.modelP - a.modelP);
  } else {
    ordered = scoreBrings(myTeam, oppSets.map(entryOf)).map(b => ({ bring: b.myIndices.map(i => myTeam[i]!), modelP: 0 }));
  }
  const shortlistIn = ordered.slice(0, myBringK);

  // DISPOSE: each shortlisted bring vs ALL opp candidate brings → maximin win-rate.
  const shortlist: BringRec['shortlist'] = [];
  let best: BringRec | null = null;
  for (const { bring, modelP } of shortlistIn) {
    const perOppBring: { oppBring: PokemonSet[]; wr: number }[] = [];
    for (const ob of oppBrings) {
      const r = await bringWinRate(pool, bring, ob, games);
      perOppBring.push({ oppBring: ob, wr: r.winRate });
    }
    const maximinWr = Math.min(...perOppBring.map(p => p.wr));
    shortlist.push({ bring, modelP, maximinWr });
    if (!best || maximinWr > best.maximinWr) best = { bring, maximinWr, perOppBring, oppBrings, shortlist };
  }
  best!.shortlist = shortlist;
  return best!;
}
