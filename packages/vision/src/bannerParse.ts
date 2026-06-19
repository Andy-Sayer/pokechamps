// Parse a Champions battle BANNER line (the bottom-of-screen message, OCR'd) into a
// structured event. This is the text→event half of the live turn read: the state
// machine consumes a stream of these (in order) and, together with HP-bar deltas,
// assembles TurnObservations → turn-log lines.
//
// Grammar was harvested from a real captured match (see [[project_live_turn_read]]):
//   "The opposing Raichu has Mega Evolved into Mega Raichu!"  · "X used Y!"
//   "X went back to <Trainer>!"  · "Go! X the <Nickname>!"  · "X fainted!"
//   "X flinched and couldn't move!"  · "X is buffeted by the sandstorm!"
//   "It's super effective on X!"  · "The battle has ended due to a forfeit."  ...
// Two hard facts from the wild:
//   1. SIDE is in the prefix — "The opposing X …" = opponent; bare "X …" = mine.
//   2. NICKNAMES appear ("Go! Sinistcha the Rank Master!") — so the banner's mon
//      label is unreliable for species; we fuzzy-match it to a legal species when we
//      can (clean labels) and otherwise return species=null (caller resolves via the
//      nameplate-icon appearance match — see colorHist.ts).
// OCR's only systematic error here is the f-ligature (ff/fl/ft → tt/tl): fainted→
// tainted, flinched→tlinched, effective→ettective, buffeted→butteted, forfeit→
// torteit. repairOcr() snaps those back before matching.

import { matchSpecies } from './fuzzyMatch.js';

export type Side = 'mine' | 'opp';

export type BattleMessage =
  | { kind: 'move'; side: Side; label: string; species: string | null; move: string }
  | { kind: 'mega'; side: Side; label: string; species: string | null }
  | { kind: 'megaReact'; side: Side; label: string; species: string | null; item: string }
  | { kind: 'faint'; side: Side; label: string; species: string | null }
  | { kind: 'switchOut'; side: Side; label: string; species: string | null; trainer: string }
  | { kind: 'switchIn'; side: Side; label: string; species: string | null; nickname: string | null; trainer?: string }
  | { kind: 'flinch'; side: Side; label: string; species: string | null }
  | { kind: 'weather'; side: Side; label: string; species: string | null; weather: string }
  | { kind: 'statChange'; side: Side; label: string; species: string | null; stats: string[]; dir: 'rose' | 'fell' }
  | { kind: 'effectiveness'; level: 'super' | 'notVery'; side: Side; label: string; species: string | null }
  | { kind: 'heal'; side: Side; label: string; species: string | null; source: string }
  | { kind: 'screen'; screen: string }
  | { kind: 'end'; reason: 'forfeit' | 'win' | 'loss'; trainer?: string }
  | { kind: 'unknown'; raw: string };

// Targeted repair of the systematic f-ligature OCR error (only these — kept narrow
// so it can't corrupt species/nicknames). Word-boundaried, case-insensitive.
const LIGATURE_FIX: [RegExp, string][] = [
  [/\btainted\b/gi, 'fainted'],
  [/\btlinched\b/gi, 'flinched'],
  [/\bett?ective\b/gi, 'effective'],
  [/\bbutt?eted\b/gi, 'buffeted'],
  [/\btorteit\b/gi, 'forfeit'],
];

/** Snap the known systematic OCR ligature errors back to their real words. */
export function repairOcr(s: string): string {
  let t = s;
  for (const [re, r] of LIGATURE_FIX) t = t.replace(re, r);
  return t;
}

const clean = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/[’`´]/g, "'").replace(/[!.]+$/, '').trim();

/** Fuzzy-resolve a banner mon-label to a legal species (null if not confident — a
 *  nickname, or too garbled; caller falls back to the nameplate appearance match). */
function resolveSpecies(label: string): string | null {
  const m = matchSpecies(label);
  return m && m.score >= 0.7 ? m.value : null;
}

const STAT_ALIASES: Record<string, string> = {
  attack: 'Attack', 'sp. atk': 'Sp. Atk', 'sp atk': 'Sp. Atk', defense: 'Defense',
  'sp. def': 'Sp. Def', 'sp def': 'Sp. Def', speed: 'Speed', accuracy: 'accuracy', evasiveness: 'evasiveness',
};
function parseStats(s: string): string[] {
  return s.split(/\s*(?:,| and )\s*/i).map(t => STAT_ALIASES[t.toLowerCase().trim()] ?? t.trim()).filter(Boolean);
}

/** Parse one OCR'd banner line into a structured battle event. */
export function parseBanner(raw: string): BattleMessage {
  const text = clean(repairOcr(raw));
  const lc = text.toLowerCase();
  let m: RegExpExecArray | null;

  // --- terminal / global states (no single mon, check before mon-prefixed forms) ---
  if (/battle has ended due to a forfeit/i.test(lc)) return { kind: 'end', reason: 'forfeit' };
  if ((m = /^you (?:defeated|beat) (.+)$/i.exec(text))) return { kind: 'end', reason: 'win', trainer: m[1]!.trim() };
  if (/(?:you (?:lost|were defeated)|defeated you)/i.test(lc)) return { kind: 'end', reason: 'loss' };
  if (/light screen made your side stronger/i.test(lc)) return { kind: 'screen', screen: 'Light Screen' };
  if (/reflect made your side stronger/i.test(lc)) return { kind: 'screen', screen: 'Reflect' };

  // --- effectiveness ("It's super effective on [the opposing] X!") ---
  if ((m = /^it'?s (super|not very) effective on (.+)$/i.exec(text))) {
    const level = /super/i.test(m[1]!) ? 'super' : 'notVery';
    const { side, label } = splitSide(m[2]!);
    return { kind: 'effectiveness', level, side, label, species: resolveSpecies(label) };
  }

  // --- switch-in: "Go! X the NICK!" (mine) / "<Trainer> sent out X!" (opp) ---
  if ((m = /^go!?\s+(.+?)(?:\s+the\s+(.+))?$/i.exec(text))) {
    const first = m[1]!.trim(), nickname = (m[2] ?? '').trim() || null;
    const sp = resolveSpecies(first);
    // "Go! <species> the <nick>" → species=first; pure nickname → species=null, label=first
    return { kind: 'switchIn', side: 'mine', label: first, species: sp, nickname };
  }
  if ((m = /^(.+?) sent out (.+)$/i.exec(text))) {
    return { kind: 'switchIn', side: 'opp', label: m[2]!.trim(), species: resolveSpecies(m[2]!.trim()), nickname: null, trainer: m[1]!.trim() };
  }

  // --- everything else is "[The opposing] <mon> <predicate>" ---
  const { side, label: rest } = splitSide(text);

  if ((m = /^(.+?) went back to (.+)$/i.exec(rest)))
    return { kind: 'switchOut', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), trainer: m[2]!.trim() };
  if ((m = /^(.+?)'s (.+?) is reacting to .+omni ring/i.exec(rest)))
    return { kind: 'megaReact', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), item: m[2]!.trim() };
  if ((m = /^(.+?) has mega evolved into mega (.+)$/i.exec(rest)))
    return { kind: 'mega', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()) };
  if ((m = /^(.+?) flinched and couldn'?t move/i.exec(rest)))
    return { kind: 'flinch', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()) };
  if ((m = /^(.+?) is buffeted by the (\w+)/i.exec(rest)))
    return { kind: 'weather', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), weather: m[2]!.toLowerCase() };
  if ((m = /^(.+?)'s (.+?) (rose|fell)(?: sharply| drastically)?$/i.exec(rest)))
    return { kind: 'statChange', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), stats: parseStats(m[2]!), dir: /rose/i.test(m[3]!) ? 'rose' : 'fell' };
  if ((m = /^(.+?) drank down all the matcha that (.+?) made/i.exec(rest)))
    return { kind: 'heal', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), source: m[2]!.trim() };
  if ((m = /^(.+?) fainted$/i.exec(rest)))
    return { kind: 'faint', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()) };
  if ((m = /^(.+?) used (.+)$/i.exec(rest)))
    return { kind: 'move', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), move: m[2]!.trim() };

  return { kind: 'unknown', raw };
}

/** Strip a leading "The opposing " (→ opp side); otherwise it's mine. */
function splitSide(s: string): { side: Side; label: string } {
  const re = /^the opposing\s+/i;
  return re.test(s) ? { side: 'opp', label: s.replace(re, '').trim() } : { side: 'mine', label: s.trim() };
}
