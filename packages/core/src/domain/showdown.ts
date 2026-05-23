import type { PokemonSet, Stats } from './types.js';
import { ZERO_EVS, MAX_IVS } from './types.js';
import { activeGimmick } from './gimmicks/index.js';
import { spFromEv } from './pikalytics.js';

// Minimal Pokemon Showdown team-export parser. Handles the common subset:
//
//   Smeargle @ Focus Sash
//   Ability: Moody
//   Level: 50
//   Tera Type: Ghost
//   EVs: 4 HP / 252 Atk / 252 Spe
//   Jolly Nature
//   IVs: 0 SpA
//   - Fake Out
//   - Spore
//   - Follow Me
//   - Tailwind
//
// Multiple sets separated by blank lines.

const STAT_KEYS: Record<string, keyof Stats> = {
  HP: 'hp', Atk: 'atk', Def: 'def', SpA: 'spa', SpD: 'spd', Spe: 'spe',
};

export function parseShowdownTeam(input: string): PokemonSet[] {
  const sets: PokemonSet[] = [];
  // Normalize line endings. Smogon Team Builder + Windows Terminal pastes
  // through Ink's keystroke-accumulating useInput arrive as CR-only ("\r"),
  // which collapses the whole team to a single line if we split on "\n".
  const normalized = input.replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const set = parseSet(lines);
    if (set) sets.push(set);
  }
  return sets;
}

function parseSet(lines: string[]): PokemonSet | null {
  const headerLine = lines.shift();
  if (!headerLine) return null;
  // Header: "Name (Species) (Gender) @ Item" — any optional pieces.
  // We only care about species and item.
  let species = '';
  let item: string | undefined;
  const atIdx = headerLine.lastIndexOf(' @ ');
  const head = atIdx >= 0 ? headerLine.slice(0, atIdx) : headerLine;
  item = atIdx >= 0 ? headerLine.slice(atIdx + 3).trim() : undefined;
  // Strip trailing (gender)
  let h = head.replace(/\s*\([MF]\)\s*$/, '').trim();
  // species is either in parentheses or is the whole thing
  const parenMatch = h.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (parenMatch) {
    species = parenMatch[2]!.trim();
  } else {
    species = h.trim();
  }

  let ability: string | undefined;
  let level = 50;
  let evs: Stats = { ...ZERO_EVS };
  let ivs: Stats = { ...MAX_IVS };
  let nature = 'Hardy';
  const moves: string[] = [];
  const draft: Partial<PokemonSet> = {};

  const gimmick = activeGimmick();

  for (const line of lines) {
    if (line.startsWith('Ability:')) ability = line.slice(8).trim();
    else if (line.startsWith('Level:')) level = parseInt(line.slice(6).trim(), 10) || 50;
    else if (line.startsWith('EVs:')) evs = parseStatLine(line.slice(4), 0);
    else if (line.startsWith('IVs:')) ivs = parseStatLine(line.slice(4), 31);
    else if (/Nature$/.test(line)) nature = line.replace(/Nature$/, '').trim();
    else if (line.startsWith('-')) {
      const move = line.slice(1).trim().split(/\s*\[/)[0]!.trim();
      if (move) moves.push(move);
    } else {
      // Unknown line — give the active gimmick a chance to consume it
      // (e.g. "Tera Type: X" when gimmick === 'tera'). Otherwise drop it.
      gimmick.parseShowdownLine?.(line, draft);
    }
  }

  return { species, level, item, ability, nature, evs, ivs, moves, ...draft };
}

function parseStatLine(rest: string, base: number): Stats {
  const out: Stats = { hp: base, atk: base, def: base, spa: base, spd: base, spe: base };
  for (const part of rest.split('/').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s+([A-Za-z]+)$/);
    if (!m) continue;
    const value = parseInt(m[1]!, 10);
    const stat = STAT_KEYS[m[2]!];
    if (stat) out[stat] = value;
  }
  return out;
}

export function formatShowdownTeam(team: PokemonSet[]): string {
  return team.map(formatShowdownSet).join('\n\n');
}

// Same as formatShowdownTeam but converts each EV value to its PoChamps
// stat-point (0–32) equivalent. The Pokemon Champions client uses the
// `EVs:` field label but expects SP values, not the standard 0–252 EV
// scale that @smogon/calc / Pokemon Showdown use internally. Round-trip
// (paste back into TeamPaste) is NOT round-tripable since the parser
// reads the field as standard EVs — this is export-only.
export function formatShowdownTeamSP(team: PokemonSet[]): string {
  return team.map(set => formatShowdownSet({ ...set, evs: evsToSp(set.evs) })).join('\n\n');
}

function evsToSp(evs: Stats): Stats {
  return {
    hp:  spFromEv(evs.hp),
    atk: spFromEv(evs.atk),
    def: spFromEv(evs.def),
    spa: spFromEv(evs.spa),
    spd: spFromEv(evs.spd),
    spe: spFromEv(evs.spe),
  };
}

function formatShowdownSet(s: PokemonSet): string {
  const lines: string[] = [];
  lines.push(`${s.species}${s.item ? ` @ ${s.item}` : ''}`);
  if (s.ability) lines.push(`Ability: ${s.ability}`);
  if (s.level !== 50) lines.push(`Level: ${s.level}`);
  for (const extra of activeGimmick().formatShowdownLines?.(s) ?? []) lines.push(extra);
  const evLine = formatStats(s.evs, 0);
  if (evLine) lines.push(`EVs: ${evLine}`);
  if (s.nature && s.nature !== 'Hardy') lines.push(`${s.nature} Nature`);
  const ivLine = formatStats(s.ivs, 31);
  if (ivLine) lines.push(`IVs: ${ivLine}`);
  for (const m of s.moves) lines.push(`- ${m}`);
  return lines.join('\n');
}

function formatStats(stats: Stats, defaultVal: number): string {
  const keys: Array<[keyof Stats, string]> = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];
  return keys
    .filter(([k]) => stats[k] !== defaultVal)
    .map(([k, label]) => `${stats[k]} ${label}`)
    .join(' / ');
}
