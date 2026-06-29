// Loads the persisted bring VALUE model (trained by mb-train-value.ts on playout
// outcomes) and scores a matchup → P(win). The fast PROPOSER half of the hybrid:
// microsecond inference to rank/shortlist brings; the simulator (the trustworthy
// half) then plays the shortlist out. Returns null when no model file is present
// (the feature degrades cleanly — callers fall back to the static score).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from './data.js';
import { matchupFeatures, FEATURE_NAMES } from './bringFeatures.js';
import { NEUTRAL_FIELD, type FieldState } from './types.js';
import type { PokemonSet } from './types.js';

interface ValueModel { featureNames: string[]; weights: number[]; bias: number; trainedOn?: number; date?: string }
let cached: ValueModel | null | undefined;

function load(): ValueModel | null {
  if (cached !== undefined) return cached;
  try {
    const p = join(dataDirPath(), 'training', 'bring-value-model.json');
    const m = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as ValueModel) : null;
    // Guard against a stale model trained on a different feature set.
    cached = m && m.featureNames.length === FEATURE_NAMES.length && m.featureNames.every((n, i) => n === FEATURE_NAMES[i]) ? m : null;
  } catch { cached = null; }
  return cached;
}

export function bringModelAvailable(): boolean { return load() != null; }
export function bringModelInfo(): { trainedOn?: number; date?: string } | null {
  const m = load(); return m ? { trainedOn: m.trainedOn, date: m.date } : null;
}

/** P(win) for `myBring` vs `oppBring` per the learned value model, or null if no
 *  model is loaded. Computes the same engine-derived features used in training. */
export function bringWinProb(myBring: PokemonSet[], oppBring: PokemonSet[], field: FieldState = NEUTRAL_FIELD): number | null {
  const m = load();
  if (!m) return null;
  const x = matchupFeatures(myBring, oppBring, field);
  const z = m.bias + m.weights.reduce((a, w, i) => a + w * (x[i] ?? 0), 0);
  return 1 / (1 + Math.exp(-z));
}
