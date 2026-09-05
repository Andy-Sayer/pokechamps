/**
 * perish-lead-gauntlet.ts — full battles, real engine, testing LEAD choice against
 * an opponent that actively sets up a perish trap several different ways.
 *
 * Everything before this tested single turns or short scripted lines. This runs
 * games to completion so the lead decision is judged on the outcome, not on
 * whether a particular turn went as planned.
 *
 * IMPORTANT — READ THIS AS RELATIVE A/B ONLY. My side plays a bounded search
 * policy, which is weaker than a human; the opponent here is SCRIPTED and plays
 * the trap deliberately well. So the absolute win rates mean little. What is
 * meaningful is the same policy, same seeds, same opponent, different LEAD.
 *
 *   npx tsx packages/core/src/scripts/perish-lead-gauntlet.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { playGame, greedyPolicy, makeSearchPolicy, type Policy } from '../domain/simPlayout.js';
import { ensureSimLoaded } from '../domain/simBridge.js';
import { dataDirPath, toId } from '../domain/data.js';
import type { PokemonSet } from '../domain/types.js';

const team: PokemonSet[] = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'TalonFlameAndyBoy.json'), 'utf8'));
const mine = (species: string): PokemonSet => {
  const m = team.find(t => t.species === species);
  if (!m) throw new Error(`${species} not on the team`);
  return m;
};

// --- the opponent, as actually seen -----------------------------------------
const set = (o: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet => ({
  item: '', ability: '', nature: 'Hardy', level: 50,
  evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  ...o,
} as PokemonSet);

const GENGAR = set({
  species: 'Gengar', ability: 'Cursed Body', item: 'Gengarite',
  moves: ['Perish Song', 'Destiny Bond', 'Shadow Ball', 'Protect'],
  nature: 'Timid', evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
});
const BLASTOISE = set({
  species: 'Blastoise', ability: 'Torrent', item: 'Leftovers',
  moves: ['Fake Out', 'Surf', 'Ice Beam', 'Protect'],
  nature: 'Bold', evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
});
const INCIN = set({
  species: 'Incineroar', ability: 'Intimidate', item: 'Safety Goggles',
  moves: ['Fake Out', 'Knock Off', 'Flare Blitz', 'Parting Shot'],
  nature: 'Careful', evs: { hp: 252, atk: 4, def: 0, spa: 0, spd: 252, spe: 0 },
});
const MILOTIC = set({
  species: 'Milotic', ability: 'Marvel Scale', item: 'Leftovers',
  moves: ['Recover', 'Scald', 'Ice Beam', 'Protect'],
  nature: 'Bold', evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
});
// A genuine MOVE-trapper, for the variant where the trap does not need the mega.
const POLITOED = set({
  species: 'Politoed', ability: 'Drizzle', item: 'Leftovers',
  moves: ['Perish Song', 'Protect', 'Scald', 'Encore'],
  nature: 'Bold', evs: { hp: 252, atk: 0, def: 252, spa: 4, spd: 0, spe: 0 },
});

// --- a scripted opponent that actually plays the trap ------------------------
export interface Plan {
  name: string;
  /** Delay the song by N turns (scouting / setting up first). */
  singOnTurn: number;
  /** Open with Fake Out where available. */
  fakeOut: boolean;
  /** Protect the singer once the clock is running, to burn my kill turns. */
  stall: boolean;
  /** Withdraw the singer when its own count reaches this, to clear and re-sing. */
  withdrawAt: number | null;
}

const idOf = (m: unknown) => toId(typeof m === 'string' ? m : (m as { id?: string })?.id ?? '');

/** Build a Policy that drives the opponent through `plan`. Falls back to the
 *  greedy policy for anything the plan does not specify, so it still fights. */
export function perishPolicy(plan: Plan): Policy {
  return (battle: any, side: number): string => {
    const req = battle.sides[side].activeRequest;
    if (!req || req.wait) return 'default';
    if (req.forceSwitch) return 'default';
    const actives = battle.sides[side].active;
    const parts: string[] = [];
    let anyScripted = false;

    for (let i = 0; i < actives.length; i++) {
      const p = actives[i];
      if (!p || p.fainted) { parts.push('pass'); continue; }
      const moves: any[] = req.active?.[i]?.moves ?? [];
      const find = (id: string) => moves.findIndex(m => idOf(m) === id && !m.disabled) + 1;
      const perish = p.volatiles?.perishsong?.duration ?? null;
      const isSinger = moves.some(m => idOf(m) === 'perishsong');
      const canMega = !!req.active?.[i]?.canMegaEvo;

      // The singer: mega + sing on schedule, stall while the clock runs, and
      // withdraw to clear its own count so it can come back and sing again.
      if (isSinger) {
        if (perish == null && battle.turn >= plan.singOnTurn) {
          const s = find('perishsong');
          if (s) { parts.push(`move ${s}${canMega ? ' mega' : ''}`); anyScripted = true; continue; }
        }
        if (plan.withdrawAt != null && perish != null && perish <= plan.withdrawAt) {
          const bench = battle.sides[side].pokemon
            .map((m: any, idx: number) => ({ m, idx }))
            .filter(({ m }: any) => !m.fainted && !m.isActive);
          if (bench.length) { parts.push(`switch ${bench[0].idx + 1}`); anyScripted = true; continue; }
        }
        if (plan.stall && perish != null) {
          const pr = find('protect');
          if (pr) { parts.push(`move ${pr}`); anyScripted = true; continue; }
        }
        if (canMega) { const sb = find('shadowball'); if (sb) { parts.push(`move ${sb} mega 1`); anyScripted = true; continue; } }
      }

      // The partner: open with Fake Out at my slot 1 — the threat slot.
      if (plan.fakeOut && battle.turn === 1) {
        const fo = find('fakeout');
        if (fo) { parts.push(`move ${fo} 1`); anyScripted = true; continue; }
      }
      // Once the clock is running, Protect to deny my kill AND my pivot.
      if (plan.stall && (actives.some((a: any) => a?.volatiles?.perishsong))) {
        const pr = find('protect');
        if (pr) { parts.push(`move ${pr}`); anyScripted = true; continue; }
      }
      parts.push('');
    }
    if (!anyScripted) return greedyPolicy(battle, side);
    // Fill any unscripted slot from the greedy choice for that slot.
    const greedy = greedyPolicy(battle, side).split(',').map(s => s.trim());
    return parts.map((p, i) => p || greedy[i] || 'default').join(', ');
  };
}

export const PLANS: Plan[] = [
  { name: 'A  Fake Out + mega-sing turn 1 (what they played)', singOnTurn: 1, fakeOut: true, stall: true, withdrawAt: 1 },
  { name: 'B  sing turn 1, no Fake Out',                      singOnTurn: 1, fakeOut: false, stall: true, withdrawAt: 1 },
  { name: 'C  scout a turn, sing turn 2',                     singOnTurn: 2, fakeOut: true, stall: true, withdrawAt: 1 },
  { name: 'D  Fake Out + sing, then STALL, never withdraw',   singOnTurn: 1, fakeOut: true, stall: true, withdrawAt: null },
  { name: 'E  sing + withdraw immediately (double song)',     singOnTurn: 1, fakeOut: true, stall: false, withdrawAt: 2 },
];

export const LEADS: { name: string; order: string[] }[] = [
  { name: 'played   Garchomp + Talonflame', order: ['Garchomp', 'Talonflame', 'Meowscarada', 'Dragonite'] },
  { name: 'advised  Meowscarada + Dragonite', order: ['Meowscarada', 'Dragonite', 'Talonflame', 'Garchomp'] },
  { name: 'perish   Meowscarada + Talonflame', order: ['Meowscarada', 'Talonflame', 'Garchomp', 'Dragonite'] },
  // Both answers on the field at once. The redundancy rule says a bring needs two
  // answers; this asks whether they should be LED together rather than staggered.
  { name: 'both     Garchomp + Meowscarada', order: ['Garchomp', 'Meowscarada', 'Talonflame', 'Dragonite'] },
];

export const OPP_TEAM = [GENGAR, BLASTOISE, INCIN, MILOTIC];
export const myMon = mine;
// --search runs the same grid with a SEARCHING policy on my side. This matters a
// lot: greedy never pivots on purpose, so it systematically under-rates any lead
// whose whole point is the pivot — and it turns out to flatter/punish leads far
// more than a competent player would. Always read both before believing a gap.
const USE_SEARCH = process.argv.includes('--search');
const SEEDS = Number(process.argv.find(a => a.startsWith('--seeds='))?.split('=')[1] ?? (USE_SEARCH ? 6 : 12));

const IS_CLI = process.argv[1]?.endsWith('perish-lead-gauntlet.ts');
if (IS_CLI && !(await ensureSimLoaded())) { console.error('@pkmn/sim not installed'); process.exit(1); }
if (IS_CLI) {

console.log('Full battles vs a scripted perish-trap opponent. RELATIVE A/B ONLY —');
console.log('my side plays a bounded policy, so absolute rates are not meaningful.\n');
console.log(`opponent: ${OPP_TEAM.map(o => o.species).join(', ')}   ${SEEDS} seeds per cell\n`);

const header = 'lead'.padEnd(32) + PLANS.map((_, i) => `  ${String.fromCharCode(65 + i)}    `).join('') + '   avg';
console.log(header);
console.log('-'.repeat(header.length));

const results: Record<string, number[]> = {};
for (const lead of LEADS) {
  const p1 = lead.order.map(mine);
  const row: number[] = [];
  for (const plan of PLANS) {
    let wins = 0;
    for (let i = 0; i < SEEDS; i++) {
      const r = await playGame(p1, OPP_TEAM, {
        seed: [i + 1, i * 3 + 2, i * 7 + 5, i * 11 + 3],
        turnCap: USE_SEARCH ? 30 : 40,
        policy: USE_SEARCH ? makeSearchPolicy(p1, OPP_TEAM, 2, 250) : greedyPolicy,
        p2Policy: perishPolicy(plan),
      });
      if ('error' in r) { console.error(r.error); process.exit(1); }
      if (r.winner === 'p1') wins++;
    }
    row.push(wins);
  }
  results[lead.name] = row;
  const avg = (row.reduce((a, b) => a + b, 0) / (row.length * SEEDS) * 100).toFixed(0);
  console.log(lead.name.padEnd(32) + row.map(w => `${String(w).padStart(3)}/${SEEDS}`).join(' ') + `   ${avg}%`);
}

console.log('\nplans:');
for (const p of PLANS) console.log(`  ${p.name}`);
}
