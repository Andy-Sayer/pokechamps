// Fuzzy matching of OCR text to the legal lists. OCR is noisy, but the candidate
// set is tiny (208 species, a mon's 4 moves), so normalized edit-distance against
// the legal names recovers the intended entry reliably. The small candidate set
// is the accuracy win — we never match against "all of English".
import { loadFormat, getSpecies, toId } from '@pokechamps/core/domain/data.js';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

/** Normalized similarity 0..1 (1 = identical after stripping case/punctuation). */
export function similarity(a: string, b: string): number {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  return 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
}

export interface FuzzyMatch { value: string; id: string; score: number; }

/** Closest candidate to `raw` by normalized edit-distance. Caller thresholds. */
export function bestMatch(raw: string, candidates: readonly string[]): FuzzyMatch | null {
  let best: FuzzyMatch | null = null;
  for (const c of candidates) {
    const score = similarity(raw, c);
    if (!best || score > best.score) best = { value: c, id: toId(c), score };
  }
  return best;
}

let speciesCache: string[] | null = null;
function legalSpeciesNames(): string[] {
  if (!speciesCache) {
    speciesCache = loadFormat().legality.allow.map(id => (getSpecies(id) as { name?: string } | undefined)?.name ?? id);
  }
  return speciesCache;
}

/** Match an OCR'd name label to a legal Champions species. */
export function matchSpecies(raw: string): FuzzyMatch | null {
  return bestMatch(raw, legalSpeciesNames());
}

/** Match an OCR'd move name against a known candidate list (the mon's 4 moves or
 *  its learnset) — far more reliable than matching the whole move dex. */
export function matchMove(raw: string, candidates: readonly string[]): FuzzyMatch | null {
  return bestMatch(raw, candidates);
}
