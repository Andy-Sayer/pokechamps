// Shared bring-recommendation logic behind BOTH the bring-lookup CLI and the TUI
// preview screen. Two independent reads for a faced opponent's 6:
//   bringThreats() — dossier-driven, ALWAYS available (no matrices needed): each opp
//     mon's role tags + which of my brought mons it hits super-effectively.
//   bringNash()    — the sim-derived Nash bring, only when a matrix exists for my team
//     (exact if the opp is a known anchor, else role-aware closest, flagged).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from './data.js';
import { solveMatrixGame } from './bringMatrixGame.js';
import { loadDossier, dossierBase, nearestAnalog, bestSEAgainst, type DossierEntry, type RoleTag } from './monDossier.js';
import { speciesTypes } from './typechart.js';

export interface OppThreat {
  species: string;
  known: boolean;                 // in the dossier at all
  roles: RoleTag[];
  inferred: boolean;              // moveset is inferred (no usage data)
  se: { mult: number; type: string; target: string } | null; // worst SE vs myMons
}

/** For each opponent species, its role tags + the strongest type-effectiveness its
 *  likely moves get against `myMons` (the 4 you'd bring, or your 6). */
export function bringThreats(oppSpecies: string[], myMons: string[]): OppThreat[] {
  const myTypes = myMons.map(n => ({ name: n, types: speciesTypes(n) }));
  return oppSpecies.map(species => {
    const e = dossierBase(species);
    if (!e) return { species, known: false, roles: [], inferred: false, se: null };
    let worst: { mult: number; type: string; target: string } | null = null;
    for (const mm of myTypes) {
      const s = bestSEAgainst(e, mm.types);
      if (s.mult >= 2 && (!worst || s.mult > worst.mult)) worst = { mult: s.mult, type: s.type, target: mm.name };
    }
    return { species, known: true, roles: e.roles, inferred: e.moveSource === 'inferred', se: worst };
  });
}

interface Mat { anchor: string; myBrings: string[]; theirBrings: string[]; M: number[][] }
export interface NashRec {
  anchor: string;
  exact: boolean;
  value: number;                  // Nash matchup value
  maximinBring: string[];
  maximinValue: number;
  mix: { bring: string[]; p: number }[];
  noAnalog: string[];             // faced mons with no safe analog in the borrowed team
  faced: string[];                // the borrowed team's 6 (for anchor-name lookups)
}

const oppNames = (m: Mat) => [...new Set(m.theirBrings.flatMap(b => b.split('/')))];

/** The Nash bring from the precomputed matrix corpus for `teamSlug`. null if no corpus
 *  is built. Exact when the opponent matches a known anchor, else the role-aware closest
 *  team is borrowed (flagged, with any no-safe-analog mons named). */
export function bringNash(teamSlug: string, oppSpecies: string[]): NashRec | null {
  const dir = join(dataDirPath(), 'matrices', teamSlug);
  if (!existsSync(dir)) return null;
  const mats: Mat[] = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Mat);
  if (!mats.length) return null;

  const wantIds = oppSpecies.map(toId);
  let chosen = mats.find(m => oppNames(m).map(toId).sort().join(',') === [...wantIds].sort().join(','))
    ?? (oppSpecies.length === 1 ? mats.find(m => m.anchor.toLowerCase().includes(oppSpecies[0]!.toLowerCase())) : undefined);
  let exact = !!chosen;
  const dossier = loadDossier();
  const entriesOf = (names: string[]) => names.map(dossierBase).filter((e): e is DossierEntry => !!e);
  if (!chosen) {
    const facedEntries = entriesOf(oppSpecies);
    if (dossier.length && facedEntries.length) {
      chosen = mats.map(m => {
        const pool = entriesOf(oppNames(m));
        const dist = facedEntries.reduce((s, e) => { const n = nearestAnalog(e, pool); return s + (n ? n.dist : 5); }, 0);
        return { m, dist };
      }).sort((a, b) => a.dist - b.dist)[0]?.m;
    } else {
      const want = new Set(wantIds);
      chosen = mats.map(m => ({ m, shared: oppNames(m).map(toId).filter(s => want.has(s)).length })).sort((a, b) => b.shared - a.shared)[0]?.m;
    }
  }
  if (!chosen) return null;
  const sol = solveMatrixGame(chosen.M);
  const mix = sol.nashRow.map((p, i) => ({ bring: chosen!.myBrings[i]!.split('/'), p })).filter(x => x.p > 0.03).sort((a, b) => b.p - a.p);
  const anchorIds = new Set(oppNames(chosen).map(toId));
  const noAnalog = exact ? [] : entriesOf(oppSpecies)
    .filter(e => { const n = nearestAnalog(e, entriesOf(oppNames(chosen!))); return !n || !n.safe; })
    .map(e => e.label);
  return { anchor: chosen.anchor, exact, value: sol.value, maximinBring: chosen.myBrings[sol.maximinRow]!.split('/'), maximinValue: sol.maximinValue, mix, noAnalog, faced: oppNames(chosen) };
}
