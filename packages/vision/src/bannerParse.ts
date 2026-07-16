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
//   2. The mon label can carry a RIBBON TITLE ("Sylveon of the Distant Past",
//      "Sinistcha the Rank Master") — these SUFFIX the real species, so
//      resolveSpecies() recovers it by token. A true CUSTOM NICKNAME instead
//      REPLACES the species with the player's free text; then species=null and the
//      caller resolves it via the nameplate-icon appearance match (see colorHist.ts).
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
  | { kind: 'switchOut'; side: Side; label: string; species: string | null; trainer?: string }
  | { kind: 'switchIn'; side: Side; label: string; species: string | null; nickname: string | null; trainer?: string }
  | { kind: 'flinch'; side: Side; label: string; species: string | null }
  | { kind: 'weather'; side: Side; label: string; species: string | null; weather: string }
  | { kind: 'statChange'; side: Side; label: string; species: string | null; stats: string[]; dir: 'rose' | 'fell'; magnitude: number }
  | { kind: 'effectiveness'; level: 'super' | 'notVery' | 'extremely' | 'immune'; side: Side; label: string; species: string | null }
  | { kind: 'heal'; side: Side; label: string; species: string | null; source: string }
  | { kind: 'ability'; side: Side; label: string; species: string | null; ability: string }
  | { kind: 'residual'; side: Side; label: string; species: string | null; source: string }
  | { kind: 'status'; side: Side; label: string; species: string | null; status: string }
  // crit: side/label name the TARGET when the doubles form ("A critical hit on X!") is
  // used; the bare singles form ("A critical hit!") has side=null → tag the last move.
  | { kind: 'crit'; side: Side | null; label: string | null; species: string | null }
  | { kind: 'protect'; side: Side; label: string; species: string | null }
  | { kind: 'miss'; side: Side; label: string; species: string | null }
  | { kind: 'hpLoss'; side: Side; label: string; species: string | null }
  | { kind: 'confusionHit' }
  | { kind: 'weatherStart'; weather: string }
  | { kind: 'weatherEnd' }
  | { kind: 'screen'; screen: string }
  | { kind: 'end'; reason: 'forfeit' | 'win' | 'loss'; trainer?: string }
  | { kind: 'unknown'; raw: string };

// Targeted repair of the systematic f-ligature OCR error (only these — kept narrow
// so it can't corrupt species/nicknames). Word-boundaried, case-insensitive.
const LIGATURE_FIX: [RegExp, string][] = [
  [/\btainted\b/gi, 'fainted'],
  [/\btlinched\b/gi, 'flinched'],
  [/\be[ft]{1,2}ective\b/gi, 'effective'],
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
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** Fuzzy-resolve a banner mon-label to a legal species (null if not confident — a
 *  nickname, or too garbled; caller falls back to the nameplate appearance match).
 *  Nicknames often EMBED the species ("Sylveon of the Distant Past"), so we also try
 *  each word, accepting a high-confidence token match over a weak whole-string one. */
function resolveSpecies(label: string): string | null {
  const full = matchSpecies(label);
  let best = full && full.score >= 0.7 ? full : null;   // clean-label / garbled fallback
  if (!best || best.score < 0.85) {
    for (const w of label.split(/\s+/)) {
      if (w.length < 4) continue;                        // skip "of", "the", …
      const m = matchSpecies(w);
      if (m && m.score >= 0.85 && (!best || m.score > best.score)) best = m;
    }
  }
  return best ? best.value : null;
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

  // --- field: weather start / end (no single mon) ---
  // END covers the real per-weather banners ("The rain stopped." etc.), not just the generic one.
  if (/the (?:rain|snow|hail) stopped|the sunlight faded|the sandstorm subsided|effects of the weather (?:disappeared|wore off)/i.test(lc)) return { kind: 'weatherEnd' };
  // START covers move-set ("It started to rain!") AND ability-set ("…'s Drizzle made it rain!").
  if (/started to rain|began to rain|it'?s raining|made it rain/i.test(lc)) return { kind: 'weatherStart', weather: 'rain' };
  if (/a sandstorm kicked up|sandstorm is raging|whipped up a sandstorm/i.test(lc)) return { kind: 'weatherStart', weather: 'sandstorm' };
  if (/sunlight turned (?:harsh|extremely harsh)|sunlight is strong|intensified the sun/i.test(lc)) return { kind: 'weatherStart', weather: 'sun' };
  if (/started to (?:hail|snow)|snow began to fall|it'?s snowing|made it snow/i.test(lc)) return { kind: 'weatherStart', weather: 'snow' };

  // --- critical hit ("A critical hit!" / "A critical hit on [the opposing] X!"). Tags
  //     the damage observation so the calc runs 1.5× — an untagged crit would read as a
  //     fake super-high roll and poison the EV/nature inference. ---
  if ((m = /^a critical hit(?: on (.+))?$/i.exec(text))) {
    if (m[1]) {
      const { side, label } = splitSide(m[1]);
      return { kind: 'crit', side, label, species: resolveSpecies(label) };
    }
    return { kind: 'crit', side: null, label: null, species: null };
  }

  // --- effectiveness ("It's {super|not very|extremely} effective on [the opposing] X!") ---
  if ((m = /^it'?s (super|not very|extremely) effective on (.+)$/i.exec(text))) {
    const level = /super/i.test(m[1]!) ? 'super' : /extremely/i.test(m[1]!) ? 'extremely' : 'notVery';
    const { side, label } = splitSide(m[2]!);
    return { kind: 'effectiveness', level, side, label, species: resolveSpecies(label) };
  }
  // immunity ("It doesn't affect X…" / "It had no effect on X")
  if ((m = /^it (?:doesn'?t affect|had no effect on|has no effect on) (.+)$/i.exec(text))) {
    const { side, label } = splitSide(m[1]!);
    return { kind: 'effectiveness', level: 'immune', side, label, species: resolveSpecies(label) };
  }
  // confusion self-hit — banner names no mon ("It hurt itself in its confusion!"); the
  // assembler attributes the HP loss to whichever active mon is confused and acting.
  if (/it hurt itself in its confusion/i.test(lc)) return { kind: 'confusionHit' };

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
  // player recalling their own mon on a manual switch ("Kingambit, come back!") — no
  // trainer named; comma optional for OCR slop. Always mine (the opp form is "went back to").
  if ((m = /^(.+?),?\s*come back$/i.exec(rest))) {
    const label = m[1]!.trim().replace(/,\s*$/, '');
    return { kind: 'switchOut', side, label, species: resolveSpecies(label) };
  }
  if ((m = /^(.+?)'s (.+?) is reacting to .+omni ring/i.exec(rest)))
    return { kind: 'megaReact', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), item: m[2]!.trim() };
  if ((m = /^(.+?) has mega evolved into mega (.+)$/i.exec(rest)))
    return { kind: 'mega', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()) };
  if ((m = /^(.+?) flinched and couldn'?t move/i.exec(rest)))
    return { kind: 'flinch', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()) };
  if ((m = /^(.+?) is buffeted by the (\w+)/i.exec(rest)))
    return { kind: 'weather', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), weather: m[2]!.toLowerCase() };
  // Adverb can sit BEFORE or AFTER the verb ("Attack rose sharply" / "Attack harshly fell").
  // sharply(+2 rise)/harshly(-2 fall) → 2 · drastically/severely → 3 · none → 1.
  if ((m = /^(.+?)'s (.+?) (?:(sharply|harshly|drastically|severely) )?(rose|fell)(?: (sharply|harshly|drastically|severely))?$/i.exec(rest))) {
    const adv = (m[3] || m[5] || '').toLowerCase();
    const magnitude = /drastically|severely/.test(adv) ? 3 : /sharply|harshly/.test(adv) ? 2 : 1;
    return { kind: 'statChange', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), stats: parseStats(m[2]!), dir: /rose/i.test(m[4]!) ? 'rose' : 'fell', magnitude };
  }
  if ((m = /^(.+?) drank down all the matcha that (.+?) made/i.exec(rest)))
    return { kind: 'heal', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), source: m[2]!.trim() };
  if ((m = /^(.+?) is exerting its (\w+)$/i.exec(rest)))
    return { kind: 'ability', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), ability: cap(m[2]!) };
  if ((m = /^(.+?) was damaged by (?:the )?(.+)$/i.exec(rest)) || (m = /^(.+?) is hurt by (?:its )?(.+)$/i.exec(rest)))
    return { kind: 'residual', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), source: m[2]!.trim().toLowerCase() };
  // self-inflicted HP loss with no named source ("X lost some of its HP!") — Life Orb,
  // Substitute, Curse, Belly Drum, etc. Self-damage: never an opponent-dealt-damage signal.
  if ((m = /^(.+?) lost some of its hp$/i.exec(rest)))
    return { kind: 'hpLoss', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()) };
  if ((m = /^(.+?) avoided the attack$/i.exec(rest)) || (m = /^(.+?)'?s attack missed$/i.exec(rest)))
    return { kind: 'miss', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()) };
  if ((m = /^(.+?) protected itself$/i.exec(rest)))
    return { kind: 'protect', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()) };
  // --- status conditions. "badly poisoned" before "poisoned"; confusion seen in the
  //     wild ("The opposing Incineroar is confused!"), the rest follow standard wording. ---
  {
    const status =
      /^.+? (?:is|was) paralyzed/i.test(rest) ? 'paralysis' :
      /^.+? was burned/i.test(rest) ? 'burn' :
      /^.+? was badly poisoned/i.test(rest) ? 'toxic' :
      /^.+? was poisoned/i.test(rest) ? 'poison' :
      /^.+? fell asleep/i.test(rest) ? 'sleep' :
      /^.+? (?:is|was) frozen solid/i.test(rest) ? 'freeze' :
      /^.+? (?:is|became) confused/i.test(rest) ? 'confusion' : null;
    if (status && (m = /^(.+?) (?:is|was|became|fell)\b/i.exec(rest)))
      return { kind: 'status', side, label: m[1]!.trim(), species: resolveSpecies(m[1]!.trim()), status };
  }
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
