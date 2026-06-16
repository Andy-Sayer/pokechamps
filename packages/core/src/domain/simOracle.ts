/**
 * simOracle.ts — the opt-in EXACT engine: resolve the recommended line (my best
 * joint play + the opponent's predicted reply) through the real Showdown engine
 * (`@pkmn/sim`) and report the ground-truth outcome as a DISTRIBUTION over RNG
 * seeds — damage rolls, accuracy, secondaries and all the fiddly mechanics the
 * fast search only approximates (`unmodeled.ts` flags those positions).
 *
 * Runtime-safe + client-side only (project_client_side_compute): the engine is
 * loaded lazily via `ensureSimLoaded()`; when `@pkmn/sim` isn't installed (a
 * lean TUI bundle without the optional dep) the result is a friendly failure,
 * never a crash. One turn × K seeds is ~10-20ms at the spike's measured
 * 700-3k turns/sec — fine to run on demand from the TUI.
 */
import type { SearchInput, SearchPlay } from './endgameSearch.js';
import { searchInputToSimPosition } from './simDiff.js';
import {
  ensureSimLoaded, buildBattle, stepTurn, readOutcome, readRoster, orderTeam,
  type SimMon, type SimSlot, type RosterMon,
} from './simBridge.js';
import { getMove, toId } from './data.js';

/** Post-turn distribution for one active mon, aggregated over seeds. */
export interface OracleMonOutcome {
  side: 'mine' | 'opp';
  species: string;
  beforeHpPct: number;
  /** Post-turn HP % envelope + mean over the seeds (0 when fainted). */
  hpMin: number;
  hpMax: number;
  hpMean: number;
  /** Fraction of seeds in which the mon fainted this turn. */
  faintRate: number;
  /** Non-volatile status GAINED this turn → fraction of seeds (e.g. {brn: 0.3}). */
  statusRates: Record<string, number>;
}

export interface OracleSuccess {
  ok: true;
  seeds: number;
  /** The Showdown choice strings the line mapped to (for transparency/debug). */
  myChoice: string;
  oppChoice: string;
  mons: OracleMonOutcome[];
  /** Field changes seen in every seed, e.g. "weather → Sand". */
  fieldNotes: string[];
}
export interface OracleFailure { ok: false; error: string }
export type OracleResult = OracleSuccess | OracleFailure;

/** The slice of a SearchResult the oracle consumes (narrow for testability). */
export interface OracleLine {
  plays: SearchPlay[];
  oppLine?: SearchPlay[];
  megaMon?: string;
}

const DEFAULT_SEEDS = 16;

// Showdown choice string for one active slot's play. `myActives`/`foeActives`
// are the species names occupying each side's active slots (sim slot order);
// `team` is the side's sim-ordered team for switch slot numbers.
function choiceForPlay(p: {
  play: SearchPlay | undefined;
  team: SimMon[];
  allyActives: string[];
  foeActives: string[];
  mega: boolean;
  /** Singles battles take no target numbers. */
  singles: boolean;
}): string | null {
  const { play, team } = p;
  if (!play) return null;
  if (play.switch) {
    // `switch N` — 1-based slot of the incoming mon in the sim-ordered team.
    const n = team.findIndex(m => toId(m.species) === toId(play.targetSpecies)) + 1;
    return n > 0 ? `switch ${n}` : null;
  }
  const id = toId(play.move ?? '');
  if (!id) return null;
  let choice = `move ${id}`;
  // Target numbering (doubles only): foes are positive 1-based slots, allies
  // negative. Only single-target moves take a number; spread/self/field omit it.
  const dexTarget = (getMove(play.move) as { target?: string } | undefined)?.target;
  const needsTarget = dexTarget === 'normal' || dexTarget === 'any' || dexTarget === 'adjacentFoe';
  if (!p.singles && !play.self && !play.spread && needsTarget) {
    const foe = p.foeActives.findIndex(s => toId(s) === toId(play.targetSpecies)) + 1;
    const ally = p.allyActives.findIndex(s => toId(s) === toId(play.targetSpecies)) + 1;
    if (foe > 0) choice += ` ${foe}`;
    else if (ally > 0) choice += ` -${ally}`;
    else return null; // target not on the field — line is stale for this board
  } else if (!p.singles && dexTarget === 'adjacentAlly') {
    const ally = p.allyActives.findIndex(s => toId(s) === toId(play.targetSpecies)) + 1;
    if (ally > 0) choice += ` -${ally}`;
  }
  if (p.mega) choice += ' mega';
  return choice;
}

/**
 * Resolve ONE turn of the recommended line through the real engine, over
 * `opts.seeds` RNG seeds (default 16), and aggregate the outcome distribution.
 * `line.plays` drives my side; `line.oppLine` the opponent's (engine-chosen
 * 'default' when absent). Fails soft: missing `@pkmn/sim`, an unmappable play,
 * or a sim-rejected choice all return `{ok: false, error}`.
 */
export async function runExactOracle(
  input: SearchInput,
  line: OracleLine,
  opts?: { seeds?: number },
): Promise<OracleResult> {
  if (!(await ensureSimLoaded())) {
    return { ok: false, error: 'exact engine unavailable — install @pkmn/sim (npm i @pkmn/sim) to enable /exact' };
  }
  const K = Math.max(1, opts?.seeds ?? DEFAULT_SEEDS);
  const pos = searchInputToSimPosition(input);
  if (!pos.p1active.length || !pos.p2active.length) return { ok: false, error: 'no active mons on one side' };

  // Board shapes the sim can faithfully load: a full 2v2 doubles board, or a
  // true 1v1 endgame (resolved as SINGLES — the sim can't start a doubles
  // battle with a one-mon side, and 1v1 loses no doubles semantics). Anything
  // in between (one active + a live bench, 2v1) can't be injected yet: the
  // doubles send-out would put a benched mon on the field. Fail honestly.
  const singles = pos.p1team.length === 1 && pos.p2team.length === 1;
  if (singles) pos.singles = true;
  if (!singles && (pos.p1active.length !== 2 || pos.p2active.length !== 2
    || pos.p1team.length < 2 || pos.p2team.length < 2)) {
    return { ok: false, error: 'exact engine supports full 2v2 boards and 1v1 endgames for now (a one-active side with a live bench can\'t be loaded into the sim)' };
  }

  const p1team = orderTeam(pos.p1team, pos.p1active);
  const p2team = orderTeam(pos.p2team, pos.p2active);
  const myActives = pos.p1active.map(i => pos.p1team[i]!.species);
  const oppActives = pos.p2active.map(j => pos.p2team[j]!.species);

  const playFor = (plays: SearchPlay[] | undefined, species: string) =>
    plays?.find(pl => toId(pl.mySpecies) === toId(species));

  // My side: every active slot must map, or the read isn't of the shown line.
  // `mega` covers both "mega THIS turn" (line.megaMon) and an already-mega'd
  // mon (megaActive): our sets stay base-forme + stone, so telling the sim to
  // mega on this turn's choice reproduces the mega stats/ability for the turn.
  // (Opp mega'd mons need no flag — their candidates carry the mega forme
  // species directly.) Champions CUSTOM megas don't exist in the sim; the
  // choice probe below rejects them with an honest error.
  const myParts: string[] = [];
  for (const [slot, sp] of myActives.entries()) {
    const alreadyMega = !!input.mine[pos.p1active[slot]!]?.megaActive;
    const c = choiceForPlay({
      play: playFor(line.plays, sp), team: p1team,
      allyActives: myActives, foeActives: oppActives,
      mega: alreadyMega || (!!line.megaMon && toId(line.megaMon) === toId(sp)),
      singles,
    });
    if (!c) return { ok: false, error: `can't map the recommended play for ${sp} to a sim choice` };
    myParts.push(c);
  }
  const myChoice = myParts.join(', ');
  // Opp side: use the predicted reply when present; otherwise let the engine
  // pick ('default') — still ground truth for MY action's mechanics.
  const oppParts = oppActives.map(sp => choiceForPlay({
    play: playFor(line.oppLine, sp), team: p2team,
    allyActives: oppActives, foeActives: myActives, mega: false, singles,
  }));
  const oppChoice = oppParts.every(c => c != null) && oppParts.length ? oppParts.join(', ') : 'default';

  // Validate the choices once on a probe battle: `side.choose()` returns false
  // on an illegal choice (and the engine would otherwise silently auto-choose a
  // default — we'd be reading the wrong line without noticing).
  {
    const probe = buildBattle({ ...pos, seed: [1, 2, 3, 4] });
    const s0 = (probe.sides[0] as unknown as { choose(c: string): boolean; choice: { error?: string } });
    const s1 = (probe.sides[1] as unknown as { choose(c: string): boolean; choice: { error?: string } });
    if (!s0.choose(myChoice)) {
      return { ok: false, error: `sim rejected my choice "${myChoice}": ${s0.choice.error ?? 'invalid'}` };
    }
    if (oppChoice !== 'default' && !s1.choose(oppChoice)) {
      return { ok: false, error: `sim rejected the opp choice "${oppChoice}": ${s1.choice.error ?? 'invalid'}` };
    }
  }

  // --- Run the K seeds -----------------------------------------------------
  interface Acc { hp: number[]; faints: number; status: Map<string, number>; before: number }
  const acc = new Map<string, Acc>(); // key: 'mine|species' / 'opp|species'
  const fieldChange = new Map<string, number>();
  let baselineDone = false;

  for (let k = 0; k < K; k++) {
    const battle = buildBattle({ ...pos, seed: [k + 1, 2 * k + 3, 5 * k + 7, 11 * k + 13] });
    const before = readOutcome(battle);
    const turnBefore = before.turn;
    let after = stepTurn(battle, myChoice, oppChoice);
    // A mid-turn faint puts the battle in an end-of-turn REPLACEMENT request, so
    // the turn hasn't advanced yet — the choices were valid (the probe accepted
    // them), the sim is just waiting for the send-in. Flush it with 'default':
    // the replacement is next-turn state and doesn't change THIS turn's resolved
    // HP/faints (read from the full roster below). Only AFTER flushing is a still-
    // stuck turn a genuine rejection.
    let guard = 0;
    while (after.turn === turnBefore && !battle.ended && (battle as { requestState?: string }).requestState === 'switch' && guard++ < 8) {
      battle.makeChoices('default', 'default');
      after = readOutcome(battle);
    }
    if (after.turn === turnBefore && !battle.ended) {
      return { ok: false, error: `sim rejected the choices ("${myChoice}" vs "${oppChoice}")` };
    }
    // Match each pre-turn active to its POST-TURN state via the full roster keyed
    // by base species — so a mega (species renamed Dragonite→Dragonite-Mega) or a
    // switch-out (left the active slots, alive on the bench) is tracked correctly,
    // not mistaken for a faint as a species-name active-slot match would.
    const roster = readRoster(battle);
    const collect = (side: 'mine' | 'opp', beforeSlots: (SimSlot | null)[], rosterSide: RosterMon[]) => {
      for (const b of beforeSlots) {
        if (!b) continue;
        const a = rosterSide.find(r => r.baseSpecies === b.baseSpecies);
        const key = `${side}|${b.baseSpecies}`;
        let e = acc.get(key);
        if (!e) { e = { hp: [], faints: 0, status: new Map(), before: b.hpPct }; acc.set(key, e); }
        const hpAfter = a ? (a.fainted ? 0 : a.hpPct) : 0; // not on the roster at all ⇒ treat as gone
        e.hp.push(hpAfter);
        if ((a ? a.fainted : true) && !b.fainted) e.faints += 1;
        const gained = a && !b.status && a.status ? a.status : '';
        if (gained) e.status.set(gained, (e.status.get(gained) ?? 0) + 1);
      }
    };
    collect('mine', before.p1, roster.p1);
    collect('opp', before.p2, roster.p2);
    const wB = before.weather || '', wA = after.weather || '';
    if (wA !== wB) fieldChange.set(`weather → ${wA || 'clear'}`, (fieldChange.get(`weather → ${wA || 'clear'}`) ?? 0) + 1);
    const tB = before.terrain || '', tA = after.terrain || '';
    if (tA !== tB) fieldChange.set(`terrain → ${tA.replace(/terrain$/, '') || 'clear'}`, (fieldChange.get(`terrain → ${tA.replace(/terrain$/, '') || 'clear'}`) ?? 0) + 1);
    baselineDone = true;
  }
  if (!baselineDone) return { ok: false, error: 'sim produced no outcome' };

  const mons: OracleMonOutcome[] = [...acc.entries()].map(([key, e]) => {
    const [side, species] = key.split('|') as ['mine' | 'opp', string];
    const statusRates: Record<string, number> = {};
    for (const [st, n] of e.status) statusRates[st] = n / K;
    return {
      side, species, beforeHpPct: e.before,
      hpMin: Math.min(...e.hp), hpMax: Math.max(...e.hp),
      hpMean: e.hp.reduce((a, b) => a + b, 0) / e.hp.length,
      faintRate: e.faints / K,
      statusRates,
    };
  });
  const fieldNotes = [...fieldChange.entries()].map(([label, n]) => n === K ? label : `${label} (${Math.round(n / K * 100)}%)`);
  return { ok: true, seeds: K, myChoice, oppChoice, mons, fieldNotes };
}

/** Compact human lines for the TUI: one header + one line per mon. */
export function formatOracleResult(r: OracleResult): string[] {
  if (!r.ok) return [`⚑ exact sim: ${r.error}`];
  const pct = (x: number) => `${Math.round(x)}%`;
  const lines = [`⚑ exact sim (${r.seeds} seeds, real engine): my "${r.myChoice}" vs opp "${r.oppChoice}"`];
  for (const m of r.mons) {
    const tag = m.side === 'mine' ? 'my ' : 'opp ';
    const parts: string[] = [];
    if (m.faintRate >= 1) parts.push('faints (all seeds)');
    else if (m.faintRate > 0) parts.push(`faints ${Math.round(m.faintRate * 100)}%`);
    if (m.faintRate < 1) {
      parts.push(m.hpMin === m.hpMax ? `ends ${pct(m.hpMax)}` : `ends ${pct(m.hpMin)}–${pct(m.hpMax)}`);
    }
    for (const [st, rate] of Object.entries(m.statusRates)) {
      parts.push(rate >= 1 ? st : `${st} ${Math.round(rate * 100)}%`);
    }
    lines.push(`  ${tag}${m.species} (${pct(m.beforeHpPct)}→): ${parts.join(' · ')}`);
  }
  for (const f of r.fieldNotes) lines.push(`  ${f}`);
  return lines;
}
