/**
 * showdownReplay.ts — J.0: parse a Pokémon Showdown replay (`|`-protocol log)
 * into a structured `BattleTranscript`: header (players / format / teams, with
 * open-team-sheet sets when `|showteam|` is present), the pre-turn-1 lead
 * block, and per-turn typed events for everything the engine walk (J.1) and
 * the legality checks (J.2) consume.
 *
 * PURE — no I/O. Fetching lives in `scripts/fetch-replay.ts`; fixtures are
 * cached under `tests/replays/` so tests never touch the network.
 *
 * Protocol reference: the official sim's SIM-PROTOCOL.md. We parse the subset
 * that carries battle STATE; chat / timers / html lines are skipped. Unknown
 * `|-minor|` lines are preserved as `{kind:'other'}` so nothing is silently
 * swallowed.
 */
import { getMove, getItem, getAbility, getSpecies, toId } from './data.js';

/** One Pokémon as revealed by the replay (team preview + reveals + OTS). */
export interface TranscriptMon {
  species: string;
  nickname?: string;
  level: number;
  gender?: string;
  item?: string;
  ability?: string;
  /** Move display names — full set from `|showteam|`, else grown from `|move|`s. */
  moves: string[];
  teraType?: string;
  /** True when item/ability/moves came from an open team sheet (`|showteam|`). */
  fromTeamSheet?: boolean;
}

export type Side = 'p1' | 'p2';
export interface Pos { side: Side; slot: number; nickname: string }

export type TranscriptEvent =
  | { kind: 'switch'; pos: Pos; species: string; level: number; hpPct: number; status?: string; forced?: boolean }
  | { kind: 'move'; pos: Pos; move: string; target?: Pos; spreadTargets?: Pos[]; missed?: boolean; failed?: boolean; still?: boolean }
  | { kind: 'damage'; pos: Pos; hpPct: number; fainted: boolean; from?: string }
  | { kind: 'heal'; pos: Pos; hpPct: number; from?: string }
  | { kind: 'sethp'; pos: Pos; hpPct: number }
  | { kind: 'status'; pos: Pos; status: string }
  | { kind: 'curestatus'; pos: Pos; status: string }
  | { kind: 'faint'; pos: Pos }
  | { kind: 'boost'; pos: Pos; stat: string; delta: number; from?: string }
  | { kind: 'weather'; weather: string; upkeep?: boolean }
  | { kind: 'fieldstart'; effect: string }
  | { kind: 'fieldend'; effect: string }
  | { kind: 'sidestart'; side: Side; effect: string }
  | { kind: 'sideend'; side: Side; effect: string }
  | { kind: 'detailschange'; pos: Pos; toForme: string }
  | { kind: 'terastallize'; pos: Pos; teraType: string }
  | { kind: 'abilityreveal'; pos: Pos; ability: string }
  | { kind: 'itemreveal'; pos: Pos; item: string; consumed?: boolean }
  | { kind: 'crit'; pos: Pos }
  | { kind: 'miss'; source: Pos; target?: Pos }
  | { kind: 'cant'; pos: Pos; reason: string }
  | { kind: 'upkeep' }
  | { kind: 'other'; line: string };

export interface TranscriptTurn { index: number; events: TranscriptEvent[] }

export interface BattleTranscript {
  format?: string;
  gametype?: string;
  players: Partial<Record<Side, string>>;
  teams: Record<Side, TranscriptMon[]>;
  /** Brought count per side (`|teamsize|` after preview), e.g. 4 in VGC. */
  teamSize: Partial<Record<Side, number>>;
  /** The pre-turn-1 send-out block: lead switches + their triggered effects. */
  leadEvents: TranscriptEvent[];
  turns: TranscriptTurn[];
  winner?: string;
}

// --- low-level token parsing -------------------------------------------------

// `p1a: Indeedee` → side p1, slot 0, nickname 'Indeedee'. Singles omit a/b.
function parsePos(token: string): Pos | null {
  const m = token.match(/^(p[12])([ab])?(?::\s*(.*))?$/);
  if (!m) return null;
  return { side: m[1] as Side, slot: m[2] === 'b' ? 1 : 0, nickname: (m[3] ?? '').trim() };
}

// `100/100`, `56/100 par`, `0 fnt` → percent + status. HP in public replays is
// already on a /100 scale; we normalise via the denominator anyway.
function parseHp(token: string): { hpPct: number; status?: string; fainted: boolean } | null {
  if (/^0\s*fnt$/.test(token.trim())) return { hpPct: 0, fainted: true };
  const m = token.trim().match(/^(\d+)\/(\d+)(?:\s+(\w+))?$/);
  if (!m) return null;
  const cur = parseInt(m[1]!, 10), max = parseInt(m[2]!, 10);
  return { hpPct: max > 0 ? (cur / max) * 100 : 0, status: m[3], fainted: cur <= 0 };
}

// `Ursaluna-Bloodmoon, L50, M` → species/level/gender.
function parseDetails(details: string): { species: string; level: number; gender?: string } {
  const parts = details.split(',').map(s => s.trim());
  let level = 100;
  let gender: string | undefined;
  for (const p of parts.slice(1)) {
    if (/^L\d+$/.test(p)) level = parseInt(p.slice(1), 10);
    else if (p === 'M' || p === 'F') gender = p;
  }
  return { species: parts[0] ?? '', level, gender };
}

const fromTag = (fields: string[]): string | undefined =>
  fields.find(f => f.startsWith('[from]'))?.slice(6).trim();

// Resolve a PACKED name (`IronBall`, `HyperVoice`) to its display name.
const itemName = (s: string) => { const it = getItem(s); return it?.exists ? it.name : s; };
const abilityName = (s: string) => { const ab = getAbility(s); return ab?.exists ? ab.name : s; };
const moveName = (s: string) => { const mv = getMove(s) as { name?: string } | undefined; return mv?.name ?? s; };
const speciesName = (s: string) => { const sp = getSpecies(s) as { name?: string } | undefined; return sp?.name ?? s; };

/** Parse one side's `|showteam|` packed team (open team sheets). OTS hides
 *  EVs/IVs/nature, so only species/item/ability/moves/level/tera carry data. */
export function parsePackedTeam(packed: string): TranscriptMon[] {
  return packed.split(']').filter(Boolean).map(entry => {
    const f = entry.split('|');
    const nick = f[0] ?? '';
    const species = speciesName(f[1] || nick);
    const extras = (f[11] ?? '').split(',');
    return {
      species,
      nickname: nick && nick !== species ? nick : undefined,
      level: f[10] ? parseInt(f[10], 10) : 100,
      gender: f[7] || undefined,
      item: f[2] ? itemName(f[2]) : undefined,
      ability: f[3] ? abilityName(f[3]) : undefined,
      moves: (f[4] ?? '').split(',').filter(Boolean).map(moveName),
      teraType: extras[extras.length - 1] || undefined,
      fromTeamSheet: true,
    };
  });
}

// --- main parser ---------------------------------------------------------------

export function parseReplayLog(log: string): BattleTranscript {
  const t: BattleTranscript = {
    players: {}, teams: { p1: [], p2: [] }, teamSize: {},
    leadEvents: [], turns: [],
  };

  // Find-or-create a team slot for (side, species) and return it. Replays
  // without team preview grow the team on first sight.
  const monFor = (side: Side, species: string, level?: number): TranscriptMon => {
    const canon = speciesName(species);
    // Formes change mid-battle (mega/tera keeps base species in `teams`):
    // match on the base species token before the first forme suffix too.
    let m = t.teams[side].find(x => toId(x.species) === toId(canon));
    if (!m) {
      m = { species: canon, level: level ?? 100, moves: [] };
      t.teams[side].push(m);
    }
    return m;
  };
  // Nickname → species per side, learned from switch events.
  const nickMap: Record<Side, Map<string, string>> = { p1: new Map(), p2: new Map() };
  const speciesAt = (pos: Pos): string =>
    nickMap[pos.side].get(pos.nickname) ?? pos.nickname;
  const monAt = (pos: Pos): TranscriptMon => monFor(pos.side, speciesAt(pos));

  let current: TranscriptEvent[] = t.leadEvents;
  let battleStarted = false;

  for (const rawLine of log.split(/\r?\n/)) {
    if (!rawLine.startsWith('|')) continue;
    const fields = rawLine.split('|').slice(1); // leading empty
    const cmd = fields[0] ?? '';
    const arg = (i: number) => fields[i] ?? '';

    switch (cmd) {
      case 'player': {
        const side = arg(1) as Side;
        if ((side === 'p1' || side === 'p2') && arg(2)) t.players[side] = arg(2);
        break;
      }
      case 'gametype': t.gametype = arg(1); break;
      case 'tier': t.format = arg(1); break;
      case 'poke': {
        const side = arg(1) as Side;
        const d = parseDetails(arg(2));
        if (side === 'p1' || side === 'p2') monFor(side, d.species, d.level).level = d.level;
        break;
      }
      case 'showteam': {
        const side = arg(1) as Side;
        if (side !== 'p1' && side !== 'p2') break;
        // Re-join: packed teams contain '|' as field separators within the arg.
        const packed = fields.slice(2).join('|');
        for (const sheetMon of parsePackedTeam(packed)) {
          const m = monFor(side, sheetMon.species, sheetMon.level);
          Object.assign(m, sheetMon);
        }
        break;
      }
      case 'teamsize': {
        const side = arg(1) as Side;
        if (side === 'p1' || side === 'p2') t.teamSize[side] = parseInt(arg(2), 10) || undefined;
        break;
      }
      case 'start': battleStarted = true; break;
      case 'turn': {
        const idx = parseInt(arg(1), 10);
        const turn: TranscriptTurn = { index: idx, events: [] };
        t.turns.push(turn);
        current = turn.events;
        break;
      }
      case 'win': t.winner = arg(1); break;

      case 'switch': case 'drag': {
        const pos = parsePos(arg(1));
        const d = parseDetails(arg(2));
        const hp = parseHp(arg(3));
        if (!pos || !hp) break;
        // Pin the nickname to the FIRST species seen for it: a mega'd mon
        // re-switching shows the mega forme in details, and we want it to keep
        // resolving to its original team entry.
        const baseSpecies = nickMap[pos.side].get(pos.nickname) ?? d.species;
        nickMap[pos.side].set(pos.nickname, baseSpecies);
        const m = monFor(pos.side, baseSpecies, d.level);
        m.level = d.level;
        if (pos.nickname && pos.nickname !== baseSpecies) m.nickname = pos.nickname;
        if (battleStarted) current.push({ kind: 'switch', pos, species: speciesName(baseSpecies), level: d.level, hpPct: hp.hpPct, status: hp.status, forced: cmd === 'drag' });
        break;
      }
      case 'move': {
        const pos = parsePos(arg(1));
        if (!pos) break;
        const move = moveName(arg(2));
        const target = arg(3) ? parsePos(arg(3)) : null;
        const tags = fields.slice(4);
        const spreadTag = tags.find(f => f.startsWith('[spread]'));
        const spreadTargets = spreadTag
          ? spreadTag.slice(8).trim().split(',').map(s => parsePos(s.trim())).filter((p): p is Pos => !!p)
          : undefined;
        const mon = monAt(pos);
        if (!mon.fromTeamSheet && !mon.moves.some(x => toId(x) === toId(move))) mon.moves.push(move);
        current.push({
          kind: 'move', pos, move,
          target: target ?? undefined, spreadTargets,
          missed: tags.includes('[miss]'), still: tags.includes('[still]'),
        });
        break;
      }
      case 'faint': {
        const pos = parsePos(arg(1));
        if (pos) current.push({ kind: 'faint', pos });
        break;
      }
      case 'detailschange': {
        const pos = parsePos(arg(1));
        if (pos) current.push({ kind: 'detailschange', pos, toForme: parseDetails(arg(2)).species });
        break;
      }
      case 'cant': {
        const pos = parsePos(arg(1));
        if (pos) current.push({ kind: 'cant', pos, reason: arg(2) });
        break;
      }
      case 'upkeep': current.push({ kind: 'upkeep' }); break;

      default: {
        if (!cmd.startsWith('-')) break; // chat/timer/html/etc.
        const minor = cmd.slice(1);
        const pos = parsePos(arg(1));
        switch (minor) {
          case 'damage': case 'heal': case 'sethp': {
            const hp = parseHp(arg(2));
            if (!pos || !hp) break;
            const from = fromTag(fields);
            if (minor === 'damage') current.push({ kind: 'damage', pos, hpPct: hp.hpPct, fainted: hp.fainted, from });
            else if (minor === 'heal') current.push({ kind: 'heal', pos, hpPct: hp.hpPct, from });
            else current.push({ kind: 'sethp', pos, hpPct: hp.hpPct });
            // `[from] item: X` reveals the item of the line's subject (or of the
            // `[of]` mon when present — e.g. Rocky Helmet chip names the holder).
            if (from?.startsWith('item:')) {
              const ofTag = fields.find(f => f.startsWith('[of]'));
              const owner = ofTag ? parsePos(ofTag.slice(4).trim()) : pos;
              if (owner) {
                const item = itemName(from.slice(5).trim());
                monAt(owner).item = item;
                current.push({ kind: 'itemreveal', pos: owner, item });
              }
            }
            break;
          }
          case 'status': case 'curestatus': {
            if (!pos) break;
            current.push({ kind: minor === 'status' ? 'status' : 'curestatus', pos, status: arg(2) });
            break;
          }
          case 'boost': case 'unboost': {
            if (!pos) break;
            const delta = parseInt(arg(3), 10) * (minor === 'unboost' ? -1 : 1);
            current.push({ kind: 'boost', pos, stat: arg(2), delta, from: fromTag(fields) });
            break;
          }
          case 'weather': {
            current.push({ kind: 'weather', weather: arg(1), upkeep: fields.includes('[upkeep]') });
            break;
          }
          case 'fieldstart': current.push({ kind: 'fieldstart', effect: arg(1) }); break;
          case 'fieldend': current.push({ kind: 'fieldend', effect: arg(1) }); break;
          case 'sidestart': case 'sideend': {
            const side = (arg(1).split(':')[0] ?? '') as Side;
            if (side === 'p1' || side === 'p2') {
              current.push({ kind: minor === 'sidestart' ? 'sidestart' : 'sideend', side, effect: arg(2) });
            }
            break;
          }
          case 'ability': {
            if (!pos) break;
            const ability = abilityName(arg(2));
            monAt(pos).ability = ability;
            current.push({ kind: 'abilityreveal', pos, ability });
            break;
          }
          case 'item': case 'enditem': {
            if (!pos) break;
            const item = itemName(arg(2));
            const mon = monAt(pos);
            if (!mon.item) mon.item = item;
            current.push({ kind: 'itemreveal', pos, item, consumed: minor === 'enditem' });
            break;
          }
          case 'terastallize': {
            if (!pos) break;
            monAt(pos).teraType = arg(2);
            current.push({ kind: 'terastallize', pos, teraType: arg(2) });
            break;
          }
          case 'crit': {
            if (pos) current.push({ kind: 'crit', pos });
            break;
          }
          case 'miss': {
            const src = parsePos(arg(1));
            const tgt = arg(2) ? parsePos(arg(2)) : null;
            if (src) current.push({ kind: 'miss', source: src, target: tgt ?? undefined });
            break;
          }
          default:
            current.push({ kind: 'other', line: rawLine });
        }
      }
    }
  }
  return t;
}

/** Convenience for the `.json` replay endpoint shape `{id, format, log, …}`. */
export function parseReplayJson(json: { log?: string }): BattleTranscript {
  return parseReplayLog(json.log ?? '');
}
