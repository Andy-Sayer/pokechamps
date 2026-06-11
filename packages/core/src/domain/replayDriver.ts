/**
 * replayDriver.ts — J.1 + J.2: walk a parsed `BattleTranscript` through the
 * PRODUCTION `match/engine.ts` (the same finalizeTurn / applyStateUpdate the
 * TUI calls — bugs surface where they live, not in a parallel stub) and emit
 * move-possibility flags along the way.
 *
 * Honesty model:
 *  - The transcript's HP/field values are GROUND TRUTH. After each engine turn
 *    we reconcile every observed mon back to the transcript (like the user's
 *    bulk `hp` line), so engine drift never compounds; gaps > the tolerance
 *    are reported as notes — the early signal J.3 (damage consistency) will
 *    formalise.
 *  - J.2 checks FLAG, never hard-fail: hidden items/abilities mean a "wrong"
 *    order or move can have a legal explanation we can't see.
 *  - Real gen9 replays carry Tera, which the Champions engine doesn't model —
 *    recorded as a note (and counted for the one-gimmick-per-battle check).
 */
import type { Match, MoveAction, OpponentEntry, PokemonSet, FieldState } from './types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from './types.js';
import type { BattleTranscript, TranscriptEvent, TranscriptMon, Pos, Side } from './showdownReplay.js';
import { finalizeTurn, applyStateUpdate, type ActiveIdx } from '../match/engine.js';
import { getLearnset, getMove, toId, loadFormat } from './data.js';
import { checkDamageEvent, type DamageCheck, type CheckMon } from './replayDamageCheck.js';

export interface LegalityFlag {
  /** Turn index (0 = the lead/send-out phase). */
  turn: number;
  kind: 'learnset' | 'switch' | 'gimmick' | 'order';
  who: string;
  detail: string;
}

export interface ReplayIngestResult {
  match: Match;
  flags: LegalityFlag[];
  /** Informational: HP reconciliation gaps, unmodelled gimmicks, parse oddities. */
  notes: string[];
  /** J.3 — per observed hit: is the damage reachable by ANY legal spread,
   *  given the known items/abilities and transcript-truth state? */
  damage: DamageCheck[];
}

export interface IngestOptions {
  /** Which replay side becomes "mine". Default p1. */
  mySide?: Side;
  /** Run the engine's spread inference during the walk (slow for off-meta
   *  species). Default false: opp candidates are pre-seeded from the revealed
   *  set so the walk stays fast; J.3/J.4 enable this for the real validation. */
  inferSpreads?: boolean;
  /** HP gap (in %) between engine prediction and transcript truth worth a note. */
  hpNoteTolerance?: number;
  /** J.4: my side's TRUE sets, when known outside the transcript (sim-generated
   *  battles / authored Champions transcripts). The log never carries EVs, and
   *  inference of the OPP needs my real stats to filter honestly. */
  mySetFor?: (species: string) => PokemonSet | undefined;
  /** J.4: seed candidates per opp species — typically [true spread, …decoys].
   *  The round-trip property then asserts the true one SURVIVES every
   *  observation's filter. Overrides the fast-walk auto-seed when provided. */
  oppCandidatesFor?: (species: string) => PokemonSet[] | undefined;
}

// Learnset WITHOUT the Champions move bans — replays are standard gen9 VGC and
// a format-banned move is not an ingest legality problem.
const PERMISSIVE_FORMAT = (): ReturnType<typeof loadFormat> =>
  ({ ...loadFormat(), moves: { ban: [] } });

const SIM_WEATHER: Record<string, FieldState['weather']> = {
  sunnyday: 'Sun', desolateland: 'Harsh Sunshine', raindance: 'Rain', primordialsea: 'Heavy Rain',
  sandstorm: 'Sand', snowscape: 'Snow', snow: 'Snow', hail: 'Hail', none: null,
};
const SIM_TERRAIN: Record<string, FieldState['terrain']> = {
  electricterrain: 'Electric', grassyterrain: 'Grassy', mistyterrain: 'Misty', psychicterrain: 'Psychic',
};

function toSet(m: TranscriptMon): PokemonSet {
  return {
    species: m.species, level: m.level || 50,
    item: m.item, ability: m.ability,
    nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: { ...MAX_IVS },
    moves: m.moves.length ? [...m.moves] : [],
  };
}

export function ingestTranscript(t: BattleTranscript, opts?: IngestOptions): ReplayIngestResult {
  const mySide: Side = opts?.mySide ?? 'p1';
  const oppSide: Side = mySide === 'p1' ? 'p2' : 'p1';
  const hpTol = opts?.hpNoteTolerance ?? 5;
  const flags: LegalityFlag[] = [];
  const notes: string[] = [];

  const myMons = t.teams[mySide];
  const oppMons = t.teams[oppSide];
  const myTeam: PokemonSet[] = myMons.map(m => opts?.mySetFor?.(m.species) ?? toSet(m));
  const opponentTeam: OpponentEntry[] = oppMons.map(m => {
    const seeded = opts?.oppCandidatesFor?.(m.species);
    return {
      species: m.species,
      level: m.level || 50,
      item: m.item ?? null,
      ability: m.ability ?? null,
      knownMoves: [...m.moves],
      // Pre-seeded candidates keep the engine walk fast (chained inference over
      // one candidate instead of the coarse grid); J.4 seeds true+decoys for
      // the round-trip property instead.
      ...(seeded ? { candidates: seeded }
        : opts?.inferSpreads ? {}
        : { candidates: [toSet(m)] }),
    };
  });

  const idxOf = (side: Side, species: string): number => {
    const list = side === mySide ? myMons : oppMons;
    return list.findIndex(m => toId(m.species) === toId(species));
  };
  // Position → team index, via the transcript's nickname-pinned species.
  const teamIndexAt = (pos: Pos): number => {
    const list = pos.side === mySide ? myMons : oppMons;
    const byNick = list.findIndex(m => (m.nickname ?? m.species) === pos.nickname || m.species === pos.nickname);
    return byNick;
  };

  // --- Lead phase ------------------------------------------------------------
  const active: Record<Side, [number | null, number | null]> = { p1: [null, null], p2: [null, null] };
  const fainted: Record<Side, Set<number>> = { p1: new Set(), p2: new Set() };
  const broughtOrder: Record<Side, number[]> = { p1: [], p2: [] };
  const gimmickUsed: Record<Side, string[]> = { p1: [], p2: [] };

  const recordSwitchIn = (pos: Pos, species: string, turn: number, forced: boolean | undefined) => {
    const idx = idxOf(pos.side, species);
    if (idx < 0) { notes.push(`turn ${turn}: unknown switch-in ${species} (${pos.side})`); return null; }
    if (fainted[pos.side].has(idx)) {
      flags.push({ turn, kind: 'switch', who: species, detail: 'switched in while fainted' });
    }
    if (!forced && active[pos.side].includes(idx)) {
      flags.push({ turn, kind: 'switch', who: species, detail: 'switched in while already active' });
    }
    active[pos.side][pos.slot] = idx;
    if (!broughtOrder[pos.side].includes(idx)) broughtOrder[pos.side].push(idx);
    return idx;
  };

  let field: FieldState = { ...NEUTRAL_FIELD };
  for (const ev of t.leadEvents) {
    if (ev.kind === 'switch') recordSwitchIn(ev.pos, ev.species, 0, ev.forced);
    else if (ev.kind === 'weather') field = { ...field, weather: SIM_WEATHER[toId(ev.weather)] ?? field.weather };
    else if (ev.kind === 'fieldstart') {
      const ter = SIM_TERRAIN[toId(ev.effect.replace(/^move:\s*/, ''))];
      if (ter) field = { ...field, terrain: ter };
      if (toId(ev.effect).includes('trickroom')) field = { ...field, trickRoom: true };
    }
  }

  let match: Match = {
    id: `replay-${Date.now()}`,
    startedAt: new Date().toISOString(),
    myTeam, opponentTeam,
    bring: [...broughtOrder[mySide]] as Match['bring'],
    opponentBrought: [...broughtOrder[oppSide]] as Match['opponentBrought'],
    turns: [], field,
    active: { mine: [null, null], theirs: [null, null] },
  };
  const activeIdx = (): ActiveIdx => ({
    mine: [active[mySide][0], active[mySide][1]],
    theirs: [active[oppSide][0], active[oppSide][1]],
  });
  // Lead boosts (seed items, Intrepid Sword…) — transcript truth, applied directly.
  for (const ev of t.leadEvents) {
    if (ev.kind !== 'boost') continue;
    const idx = teamIndexAt(ev.pos);
    if (idx < 0) continue;
    const r = applyStateUpdate({
      match, activeIdx: activeIdx(),
      update: { side: ev.pos.side === mySide ? 'mine' : 'theirs', teamIndex: idx, boosts: { [ev.stat]: ev.delta } },
    });
    match = r.match;
  }

  // --- Per-turn walk -----------------------------------------------------------
  const key = (side: Side, idx: number) => `${side}|${idx}`;
  // Last transcript-confirmed HP per mon, across turns — feeds the post-hoc
  // damage annotation on recorded actions in fast-walk mode.
  const lastKnownHp = new Map<string, number>();
  // J.3 transcript-truth state at hit time (independent of the engine walk —
  // the damage check tests the CALC, not the engine's state inference).
  const damage: DamageCheck[] = [];
  const runningHp = new Map<string, number>();             // updated on every observed HP
  const boostsTruth = new Map<string, Record<string, number>>();
  const statusTruth = new Map<string, string>();
  const teraSet = new Set<string>();
  const itemGone = new Set<string>();
  const glaiveVuln = new Set<string>();                    // Glaive Rush ×2-taken volatile
  const formeNow = new Map<string, string>();              // detailschange (mega) formes
  const screens: Record<Side, { reflect: boolean; lightScreen: boolean }> = {
    p1: { reflect: false, lightScreen: false }, p2: { reflect: false, lightScreen: false },
  };
  // Pre-battle statuses/HP from the lead block.
  for (const ev of t.leadEvents) {
    if (ev.kind === 'switch') {
      const idx = teamIndexAt(ev.pos);
      if (idx >= 0) {
        runningHp.set(key(ev.pos.side, idx), ev.hpPct);
        if (ev.status) statusTruth.set(key(ev.pos.side, idx), ev.status);
      }
    } else if (ev.kind === 'boost') {
      const idx = teamIndexAt(ev.pos);
      if (idx >= 0) {
        const b = boostsTruth.get(key(ev.pos.side, idx)) ?? {};
        b[ev.stat] = Math.max(-6, Math.min(6, (b[ev.stat] ?? 0) + ev.delta));
        boostsTruth.set(key(ev.pos.side, idx), b);
      }
    }
  }
  // CheckMon snapshot for the J.3 envelope check.
  const checkMonAt = (pos: Pos): { mon: CheckMon; k: string } | null => {
    const idx = teamIndexAt(pos);
    if (idx < 0) return null;
    const k = key(pos.side, idx);
    const sheet = (pos.side === mySide ? myMons : oppMons)[idx]!;
    return {
      k,
      mon: {
        species: formeNow.get(k) ?? sheet.species,
        level: sheet.level || 50,
        // OTS/reveals make the item KNOWN; consumed → known none; otherwise unknown.
        item: itemGone.has(k) ? '' : sheet.item,
        ability: sheet.ability,
        moves: sheet.moves,
        boosts: boostsTruth.get(k) as CheckMon['boosts'],
        status: statusTruth.get(k),
        curHpPct: runningHp.get(k) ?? 100,
        tera: teraSet.has(k),
        doubleDamageTaken: glaiveVuln.has(k),
      },
    };
  };
  const learnsetCache = new Map<string, Set<string>>();
  const learnsetOf = (species: string): Set<string> => {
    let s = learnsetCache.get(species);
    if (!s) {
      s = new Set(getLearnset(species, PERMISSIVE_FORMAT()).map(toId));
      learnsetCache.set(species, s);
    }
    return s;
  };
  // Effective priority for the order check: base move priority, plus the
  // known bumps we can verify (Prankster on status moves, Gale Wings at full
  // HP) when the attacker's ability is revealed. Flag-only downstream.
  const prioOf = (species: string, side: Side, move: string): number => {
    const md = getMove(move) as { priority?: number; category?: string; type?: string } | undefined;
    let p = md?.priority ?? 0;
    const mon = (side === mySide ? myMons : oppMons)[idxOf(side, species)];
    const abil = toId(mon?.ability ?? '');
    if (abil === 'prankster' && md?.category === 'Status') p += 1;
    if (abil === 'galewings' && md?.type === 'Flying') p += 1; // HP gate unknowable mid-walk — tolerant
    return p;
  };

  for (const turn of t.turns) {
    const startIdx = activeIdx();
    const actions: MoveAction[] = [];
    const postUpdates: { side: Side; idx: number; ev: TranscriptEvent }[] = [];
    // Ground-truth HP per (side, idx) — the LAST observed value this turn.
    const truthHp = new Map<string, number>();
    const truthFaint = new Set<string>();
    const noteHp = (pos: Pos, hpPct: number, faintedNow: boolean) => {
      const idx = teamIndexAt(pos);
      if (idx < 0) return;
      truthHp.set(key(pos.side, idx), hpPct);
      runningHp.set(key(pos.side, idx), hpPct);
      if (faintedNow) truthFaint.add(key(pos.side, idx));
    };

    let order = 0;
    let afterUpkeep = false;
    const moveOrderSeen: { species: string; side: Side; move: string; prio: number }[] = [];
    // Helping Hand recipients this turn (cleared at turn end).
    const hhActive = new Set<string>();

    for (let e = 0; e < turn.events.length; e++) {
      const ev = turn.events[e]!;
      switch (ev.kind) {
        case 'upkeep': afterUpkeep = true; break;

        case 'switch': {
          // The outgoing occupant's boosts + volatiles clear on switch-out
          // (status sticks).
          const prevOccupant = active[ev.pos.side][ev.pos.slot];
          if (prevOccupant != null) {
            boostsTruth.delete(key(ev.pos.side, prevOccupant));
            glaiveVuln.delete(key(ev.pos.side, prevOccupant));
          }
          const idx = recordSwitchIn(ev.pos, ev.species, turn.index, ev.forced);
          if (idx == null || idx < 0) break;
          boostsTruth.delete(key(ev.pos.side, idx)); // fresh arrival, no stages
          if (ev.status) statusTruth.set(key(ev.pos.side, idx), ev.status);
          noteHp(ev.pos, ev.hpPct, false);
          if (afterUpkeep) {
            // Replacement send-in after a faint — a state update, not a chosen action.
            postUpdates.push({ side: ev.pos.side, idx, ev });
          } else {
            order += 1;
            const aSide = (ev.pos.side === mySide ? 'mine' : 'theirs') as MoveAction['side'];
            actions.push({
              side: aSide, attackerSlot: ev.pos.slot as 0 | 1, kind: 'switch',
              move: 'switch', target: { side: aSide, slot: ev.pos.slot as 0 | 1 },
              targetTeamIndex: idx, order,
            } as MoveAction);
          }
          break;
        }

        case 'move': {
          const species = speciesOf(t, ev.pos);
          const atkIdx = teamIndexAt(ev.pos);
          if (atkIdx < 0) break;
          // Acting ends a Glaive Rush vulnerability (a fresh use re-applies it
          // via its own |-singlemove| right after).
          glaiveVuln.delete(key(ev.pos.side, atkIdx));
          // J.2 learnset check (skip Struggle / transcript oddities).
          if (toId(ev.move) !== 'struggle') {
            const ls = learnsetOf(species);
            if (ls.size && !ls.has(toId(ev.move))) {
              flags.push({ turn: turn.index, kind: 'learnset', who: species, detail: `${ev.move} not in learnset` });
            }
          }
          // J.2 order check: a later mover in a HIGHER priority bracket than an
          // earlier one is impossible (modulo hidden Quick Claw/Custap — flag only).
          const prio = prioOf(species, ev.pos.side, ev.move);
          for (const prev of moveOrderSeen) {
            if (prio > prev.prio) {
              flags.push({
                turn: turn.index, kind: 'order', who: species,
                detail: `${ev.move} (prio ${prio}) moved after ${prev.species}'s ${prev.move} (prio ${prev.prio})`,
              });
              break;
            }
          }
          moveOrderSeen.push({ species, side: ev.pos.side, move: ev.move, prio });

          // Collect this move's damage/crit/status consequences (events up to
          // the next move/switch/upkeep), then emit one action per damaged
          // target — or a single no-damage action for status/missed moves.
          order += 1;
          const block: TranscriptEvent[] = [];
          for (let j = e + 1; j < turn.events.length; j++) {
            const nx = turn.events[j]!;
            if (nx.kind === 'move' || nx.kind === 'switch' || nx.kind === 'upkeep') break;
            // Future Sight / Doom Desire land via their own `-end` right after
            // someone else's move — terminate the block so the delayed damage
            // doesn't get attributed to that move.
            if (nx.kind === 'moveend' && /future\s*sight|doom\s*desire/i.test(nx.effect)) break;
            block.push(nx);
          }
          const side = ev.pos.side === mySide ? 'mine' : 'theirs';
          const critTargets = new Set(block.filter(b => b.kind === 'crit').map(b => key((b as { pos: Pos }).pos.side, teamIndexAt((b as { pos: Pos }).pos))));
          const damages = block.filter((b): b is Extract<TranscriptEvent, { kind: 'damage' }> =>
            b.kind === 'damage' && !b.from); // [from]-tagged damage is residual/item, not this hit
          const mkAction = (target: Pos | undefined, dmg?: Extract<TranscriptEvent, { kind: 'damage' }>): MoveAction => {
            const tIdx = target ? teamIndexAt(target) : -1;
            const tSide = target ? (target.side === mySide ? 'mine' : 'theirs') : side;
            const a: MoveAction = {
              side: side as MoveAction['side'], attackerSlot: ev.pos.slot as 0 | 1, attackerTeamIndex: atkIdx,
              kind: 'move', move: ev.move,
              target: target ? { side: tSide as 'mine' | 'theirs', slot: target.slot as 0 | 1 } : 'self',
              targetTeamIndex: target && tIdx >= 0 ? tIdx : undefined,
              order,
            } as MoveAction;
            if (dmg && target) {
              a.targetRemainingHpPercent = dmg.hpPct;
              if (critTargets.has(key(target.side, teamIndexAt(target)))) a.critical = true;
              const st = block.find(b => b.kind === 'status' && samePos(b.pos, target));
              if (st && st.kind === 'status') a.targetStatus = st.status as MoveAction['targetStatus'];
            }
            const selfSt = block.find(b => b.kind === 'status' && samePos((b as { pos: Pos }).pos, ev.pos));
            if (selfSt && selfSt.kind === 'status') a.attackerStatus = selfSt.status as MoveAction['attackerStatus'];
            return a;
          };
          if (damages.length) {
            const atkInfo = checkMonAt(ev.pos);
            for (const d of damages) {
              // J.3: envelope check at hit time — BEFORE noteHp moves the truth.
              const defInfo = checkMonAt(d.pos);
              if (atkInfo && defInfo && !ev.missed) {
                const defScr = screens[d.pos.side];
                damage.push(checkDamageEvent({
                  turn: turn.index, move: ev.move,
                  critical: critTargets.has(key(d.pos.side, teamIndexAt(d.pos))),
                  spreadHit: !!ev.spreadTargets && damages.length >= 2,
                  helpingHand: hhActive.has(atkInfo.k),
                  // attackerSide is always 'mine' in the check, so the
                  // defender's screens ride the `their*` flags.
                  field: {
                    ...NEUTRAL_FIELD,
                    weather: match.field?.weather ?? null,
                    terrain: match.field?.terrain ?? null,
                    theirReflect: defScr.reflect,
                    theirLightScreen: defScr.lightScreen,
                  },
                  attacker: atkInfo.mon, defender: defInfo.mon,
                  beforePct: runningHp.get(defInfo.k) ?? 100,
                  afterPct: d.hpPct, fainted: d.fainted,
                }));
              }
              actions.push(mkAction(d.pos, d));
              noteHp(d.pos, d.hpPct, d.fainted);
            }
          } else {
            actions.push(mkAction(ev.target && ev.target.nickname ? ev.target : undefined));
          }
          break;
        }

        case 'singleturn': {
          if (/helping\s*hand/i.test(ev.effect)) {
            const idx = teamIndexAt(ev.pos);
            if (idx >= 0) hhActive.add(key(ev.pos.side, idx));
          }
          break;
        }
        case 'singlemove': {
          if (/glaive\s*rush/i.test(ev.effect)) {
            const idx = teamIndexAt(ev.pos);
            if (idx >= 0) glaiveVuln.add(key(ev.pos.side, idx));
          }
          break;
        }
        case 'boost': {
          const idx = teamIndexAt(ev.pos);
          if (idx >= 0) {
            const k = key(ev.pos.side, idx);
            const b = boostsTruth.get(k) ?? {};
            b[ev.stat] = Math.max(-6, Math.min(6, (b[ev.stat] ?? 0) + ev.delta));
            boostsTruth.set(k, b);
          }
          break;
        }
        case 'status': {
          const idx = teamIndexAt(ev.pos);
          if (idx >= 0) statusTruth.set(key(ev.pos.side, idx), ev.status);
          break;
        }
        case 'curestatus': {
          const idx = teamIndexAt(ev.pos);
          if (idx >= 0) statusTruth.delete(key(ev.pos.side, idx));
          break;
        }
        case 'itemreveal': {
          if (ev.consumed) {
            const idx = teamIndexAt(ev.pos);
            if (idx >= 0) itemGone.add(key(ev.pos.side, idx));
          }
          break;
        }
        case 'sidestart': case 'sideend': {
          const on = ev.kind === 'sidestart';
          const eff = toId(ev.effect);
          if (eff.includes('reflect')) screens[ev.side].reflect = on;
          if (eff.includes('lightscreen')) screens[ev.side].lightScreen = on;
          if (eff.includes('auroraveil')) { screens[ev.side].reflect = on; screens[ev.side].lightScreen = on; }
          break;
        }

        case 'detailschange': {
          // Mega evolution: count for the one-gimmick check; the engine's mega
          // path needs Champions stones, so a real-replay mega is note-only.
          // The J.3 check DOES use the new forme (real stats/typing).
          {
            const idx = teamIndexAt(ev.pos);
            if (idx >= 0) formeNow.set(key(ev.pos.side, idx), ev.toForme);
          }
          gimmickUsed[ev.pos.side].push(`mega:${ev.toForme}`);
          if (gimmickUsed[ev.pos.side].length > 1) {
            flags.push({ turn: turn.index, kind: 'gimmick', who: speciesOf(t, ev.pos), detail: 'second gimmick activation in one battle' });
          }
          break;
        }
        case 'terastallize': {
          {
            const idx = teamIndexAt(ev.pos);
            if (idx >= 0) teraSet.add(key(ev.pos.side, idx));
          }
          gimmickUsed[ev.pos.side].push(`tera:${ev.teraType}`);
          notes.push(`turn ${turn.index}: ${speciesOf(t, ev.pos)} terastallized (${ev.teraType}) — not modelled by the Champions engine`);
          if (gimmickUsed[ev.pos.side].length > 1) {
            flags.push({ turn: turn.index, kind: 'gimmick', who: speciesOf(t, ev.pos), detail: 'second gimmick activation in one battle' });
          }
          break;
        }

        case 'damage': case 'heal': case 'sethp':
          // Residual/item HP changes outside a move block still update truth.
          noteHp(ev.pos, ev.hpPct, ev.kind === 'damage' && ev.fainted);
          break;
        case 'faint': {
          const idx = teamIndexAt(ev.pos);
          if (idx >= 0) {
            truthFaint.add(key(ev.pos.side, idx)); truthHp.set(key(ev.pos.side, idx), 0);
            runningHp.set(key(ev.pos.side, idx), 0);
            fainted[ev.pos.side].add(idx);
            boostsTruth.delete(key(ev.pos.side, idx));
            glaiveVuln.delete(key(ev.pos.side, idx));
          }
          break;
        }
        case 'weather':
          match.field = { ...(match.field ?? NEUTRAL_FIELD), weather: SIM_WEATHER[toId(ev.weather)] ?? null };
          break;
        case 'fieldstart': {
          const ter = SIM_TERRAIN[toId(ev.effect.replace(/^move:\s*/, ''))];
          if (ter) match.field = { ...(match.field ?? NEUTRAL_FIELD), terrain: ter };
          if (toId(ev.effect).includes('trickroom')) match.field = { ...(match.field ?? NEUTRAL_FIELD), trickRoom: true };
          break;
        }
        case 'fieldend': {
          if (toId(ev.effect).includes('trickroom')) match.field = { ...(match.field ?? NEUTRAL_FIELD), trickRoom: false };
          else if (SIM_TERRAIN[toId(ev.effect.replace(/^move:\s*/, ''))]) match.field = { ...(match.field ?? NEUTRAL_FIELD), terrain: null };
          break;
        }
        default: break;
      }
    }

    // Drive the PRODUCTION engine with this turn's actions. Fast-walk mode
    // strips the per-action HP observations first: with them present the
    // engine runs spread inference per damaging hit, and against the driver's
    // 0-EV placeholder sets the damage filter barely narrows — consecutive
    // observations chain scoreOffensiveSpread's ×9 EV expansion into a
    // geometric blow-up (measured: 71s for ONE turn of a real 15-turn replay).
    // HP is reconciled from transcript truth below either way, and the
    // recorded actions get their damage annotated back afterwards, so the
    // saved match loses nothing. J.3/J.4 set `inferSpreads` to feed the real
    // observations through the inverse solver — that's where its cost (and
    // growth behaviour) is the thing under test.
    const startField = match.field ?? NEUTRAL_FIELD;
    const engineActions = opts?.inferSpreads
      ? actions
      : actions.map(a => ({ ...a, targetRemainingHpPercent: undefined, targetRemainingHpRaw: undefined }));
    const res = finalizeTurn({ match, turn: { actions: engineActions, field: startField }, activeIdx: startIdx });
    match = res.match;
    if (!opts?.inferSpreads) {
      // Annotate the recorded turn with the observed HP/damage for display
      // (summary / quick-replay tallies read damageHpPercent).
      const recorded = match.turns[match.turns.length - 1]?.actions ?? [];
      recorded.forEach((ra, i) => {
        const orig = actions[i];
        if (!orig || orig.targetRemainingHpPercent == null || ra.kind !== 'move') return;
        ra.targetRemainingHpPercent = orig.targetRemainingHpPercent;
        const k = typeof orig.target === 'object' && orig.targetTeamIndex != null
          ? key(orig.target.side === 'mine' ? mySide : oppSide, orig.targetTeamIndex) : null;
        if (k) {
          const prev = lastKnownHp.get(k) ?? 100;
          ra.damageHpPercent = Math.max(0, prev - orig.targetRemainingHpPercent);
          lastKnownHp.set(k, orig.targetRemainingHpPercent);
        }
      });
    }

    // Reconcile to transcript truth: HP + faints are authoritative.
    for (const [k, hp] of truthHp) lastKnownHp.set(k, hp);
    for (const [k, hp] of truthHp) {
      const [side, idxStr] = k.split('|') as [Side, string];
      const idx = parseInt(idxStr, 10);
      const engineSide = side === mySide ? 'mine' : 'theirs';
      const engineHp = engineSide === 'mine'
        ? hpPctOfMine(match, idx)
        : (match.opponentTeam[idx]?.currentHpPercent ?? 100);
      // The engine-vs-replay HP gap is only a meaningful signal when the
      // engine actually modelled the damage (inferSpreads / J.3) — the fast
      // walk strips observations, so every hit would "diverge".
      if (opts?.inferSpreads && Math.abs(engineHp - hp) > hpTol && !truthFaint.has(k)) {
        notes.push(`turn ${turn.index}: ${monName(t, side, idx)} engine ${engineHp.toFixed(0)}% vs replay ${hp.toFixed(0)}% — reconciled`);
      }
      const r = applyStateUpdate({
        match, activeIdx: activeIdx(),
        update: { side: engineSide, teamIndex: idx, hpPercent: hp, ...(truthFaint.has(k) ? { fainted: true } : {}) },
      });
      match = r.match;
    }
    // Replacement send-ins (post-upkeep switches) land as state updates.
    for (const p of postUpdates) {
      const r = applyStateUpdate({
        match, activeIdx: activeIdx(),
        update: { side: p.side === mySide ? 'mine' : 'theirs', teamIndex: p.idx, bringIntoSlot: (p.ev as { pos: Pos }).pos.slot as 0 | 1 },
      });
      match = r.match;
    }
  }

  if (t.winner) {
    match.outcome = t.winner === t.players[mySide] ? 'victory'
      : t.winner === t.players[oppSide] ? 'defeat' : undefined;
  }
  return { match, flags, notes, damage };

  function hpPctOfMine(m: Match, idx: number): number {
    // engine.ts stores myCurrentHp as a PERCENT (every input path normalises
    // raw → pct before writing), so the value reads back directly.
    return m.myCurrentHp?.[idx] ?? 100;
  }
}

function samePos(a: Pos, b: Pos): boolean {
  return a.side === b.side && a.nickname === b.nickname;
}
function speciesOf(t: BattleTranscript, pos: Pos): string {
  const m = t.teams[pos.side].find(x => (x.nickname ?? x.species) === pos.nickname || x.species === pos.nickname);
  return m?.species ?? pos.nickname;
}
function monName(t: BattleTranscript, side: Side, idx: number): string {
  return t.teams[side][idx]?.species ?? `${side}#${idx}`;
}
