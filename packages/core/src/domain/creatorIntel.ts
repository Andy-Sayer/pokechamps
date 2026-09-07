// Creator-intel (increments 1-2, LLM-free): turn a content-creator video into an
// OPPONENT threat team for the gauntlet — a LEADING meta indicator vs Pikalytics'
// lagging usage. NOT for our own use; purely to test our team against emerging
// threats early. Pipeline: captions (yt-dlp, fetched separately) → mentioned legal
// species → a validated, gauntlet-ready threat team. Caption text is messy
// (auto-subs mangle names), so transcript extraction is a CANDIDATE generator;
// confirming the exact 6 ideally comes from vision/team-preview (increment 3) or
// the --species flag. See docs/notes/creator-intel-plan.md.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadFormat, isLegalSpecies, getSpecies, toId, dataDirPath } from './data.js';
import { getMegaOptions } from './gimmicks/mega.js';
import { loadPikaData } from './metaTeams.js';
import { buildSetOrInfer, describeSources, type SourcedSet } from './inferredSets.js';
import type { PokemonSet } from './types.js';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** WebVTT (yt-dlp `--write-auto-sub --sub-format vtt`) → plain transcript text. */
export function parseVtt(vtt: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of vtt.split('\n')) {
    const l = raw.trim();
    if (!l || l.includes('-->') || /^(WEBVTT|NOTE|Kind:|Language:|\d+)$/.test(l)) continue;
    const clean = l.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim(); // strip cue tags + entities
    if (!clean || seen.has(clean)) continue; // auto-subs repeat rolling lines
    seen.add(clean);
    out.push(clean);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

/** Legal Champions species mentioned in the text, by mention count (desc). A rough
 *  candidate list — over-collects (a creator discusses the meta, not just their 6). */
export function extractMentionedSpecies(text: string): { species: string; count: number }[] {
  const hay = norm(text);
  const out: { species: string; count: number }[] = [];
  for (const id of loadFormat().legality.allow) {
    const name = (getSpecies(id) as { name?: string } | undefined)?.name ?? id;
    const needle = norm(name);
    if (needle.length < 4) continue; // skip short names prone to false substring hits
    let count = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) >= 0) { count++; i += needle.length; }
    if (count) out.push({ species: name, count });
  }
  return out.sort((a, b) => b.count - a.count);
}

export interface ThreatTeam {
  anchor: string; sets: PokemonSet[]; source: string; species: string[];
  /** How the sets were built — "N from usage · M analog-spread (X~Y)". Present
   *  from 2026-09-07; absent on threat files saved before that, which were
   *  100% usage-built by construction (the builder could not do anything else). */
  provenance?: string;
}

/** Build a gauntlet-ready threat team from a CONFIRMED species list (≤6). Validates
 *  legality, builds real sets (Pikalytics, item-clause-respecting), and falls back
 *  to dossier inference for species with no usage yet — the rotation window this
 *  tool exists for. `team.provenance` says which sets were which; surface it. */
export function buildThreatTeam(species: string[], source: string): { team: ThreatTeam } | { error: string } {
  const legal = species.filter(s => isLegalSpecies(toId(s)));
  const illegal = species.filter(s => !isLegalSpecies(toId(s)));
  if (legal.length < 4) return { error: `only ${legal.length} legal species (need ≥4)${illegal.length ? `; illegal: ${illegal.join(', ')}` : ''}` };
  const pika = loadPikaData();
  const used = new Set<string>();
  const sourced: SourcedSet[] = [];
  const failed: string[] = [];
  // A newly-legal mon has no usage for ~2 weeks after a rotation, which is exactly
  // the window creator intel exists to cover — so fall back to the dossier rather
  // than dropping the mon the video is about. Item clause and the one-mega rule are
  // tracked across the six as we go.
  let megaAvailable = true;
  for (const sp of legal.slice(0, 6)) {
    const name = (getSpecies(toId(sp)) as { name?: string } | undefined)?.name ?? sp;
    const s = buildSetOrInfer(pika, name, used, { megaAvailable });
    if (!s) { failed.push(sp); continue; }
    sourced.push(s);
    if (s.set.item) {
      used.add(s.set.item);
      if (getMegaOptions(s.set.species).some(m => toId(m.stone) === toId(s.set.item!))) megaAvailable = false;
    }
  }
  if (sourced.length < 4) return { error: `built only ${sourced.length} sets (no usage and no dossier entry for: ${failed.join(', ')}) — run npm run build-dossier` };
  const sets = sourced.map(s => s.set);
  return { team: { anchor: source, sets, source, species: sets.map(s => s.species), provenance: describeSources(sourced) } };
}

/** Load saved creator threat teams (data/threats/*.json) as gauntlet entries,
 *  tagged [creator] so the gauntlet report distinguishes them from [meta]/[hand]. */
export function loadCreatorThreats(): { anchor: string; sets: PokemonSet[] }[] {
  const dir = join(dataDirPath(), 'threats');
  if (!existsSync(dir)) return [];
  const out: { anchor: string; sets: PokemonSet[] }[] = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    try {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ThreatTeam;
      if (t.sets?.length >= 4) out.push({ anchor: `[creator] ${t.anchor}`, sets: t.sets });
    } catch { /* skip a malformed threat file */ }
  }
  return out;
}
