/**
 * perish-fakeout.ts — the perish trap behind a FAKE OUT lead, and what this team
 * does about it. Resolved through @pkmn/sim with the TalonFlameAndyBoy sets.
 *
 * Fake Out is +3 priority, so it beats Gale Wings (+1) and it beats the Choice
 * Scarf. That kills the turn-1 answer outright: Garchomp never gets to click
 * Earthquake, and the song lands for free. The standard partner is INCINEROAR,
 * which brings a second problem — Intimidate drops my Attack by one stage before
 * anything happens, so both of the KO lines have to be re-checked at -1.
 *
 * The question this answers is not "can I still win turn 1" (I cannot) but
 * "does Fake Out beat the plan, or only delay it by a turn".
 *
 *   npx tsx packages/core/src/scripts/perish-fakeout.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBattle, ensureSimLoaded, type SimMon } from '../domain/simBridge.js';
import { dataDirPath, toId, getMove } from '../domain/data.js';

interface TeamMon {
  species: string; item?: string | null; ability?: string | null; nature?: string;
  moves: string[]; evs?: Record<string, number>; ivs?: Record<string, number>;
}
const team: TeamMon[] = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'TalonFlameAndyBoy.json'), 'utf8'));
const mine = (species: string): SimMon => {
  const m = team.find(t => t.species === species);
  if (!m) throw new Error(`${species} not on the team`);
  return {
    species: m.species, ability: m.ability ?? undefined, item: m.item ?? '',
    moves: m.moves.map(toId), nature: m.nature ?? 'Hardy',
    evs: m.evs as SimMon['evs'], ivs: m.ivs as SimMon['ivs'], level: 50,
  };
};
const slot = (species: string, move: string): number => {
  const m = team.find(t => t.species === species)!;
  const i = m.moves.findIndex(x => toId(x) === toId(move));
  if (i < 0) throw new Error(`${species} has no ${move}`);
  return i + 1;
};

const gengar: SimMon = {
  species: 'Gengar', ability: 'Cursed Body', item: 'Gengarite',
  moves: ['perishsong', 'shadowball', 'protect', 'sludgebomb'],
  nature: 'Timid', evs: { hp: 4, spa: 252, spe: 252 }, level: 50,
};
// The classic Fake Out partner: +3 priority flinch AND Intimidate on the way in.
const incin: SimMon = {
  species: 'Incineroar', ability: 'Intimidate', item: 'Safety Goggles',
  moves: ['fakeout', 'knockoff', 'partingshot', 'protect'],
  nature: 'Careful', evs: { hp: 252, atk: 4, spd: 252 }, level: 50,
};
const milotic: SimMon = {
  species: 'Milotic', ability: 'Marvel Scale', item: 'Leftovers',
  moves: ['recover', 'scald', 'protect', 'icebeam'],
  nature: 'Bold', evs: { hp: 252, def: 252, spd: 4 }, level: 50,
};

export interface FakeOutFinding { headline: string; ok: boolean; detail: string }
const findings: FakeOutFinding[] = [];
const say = (headline: string, ok: boolean, detail: string) => {
  findings.push({ headline, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${headline}\n    ${detail}`);
};

const perishOf = (p: any): number | null => p?.volatiles?.['perishsong']?.duration ?? null;
const byBase = (side: any, base: string) =>
  side.pokemon.find((p: any) => (p.species.baseSpecies || p.species.name) === base);
const settle = (b: any) => {
  for (let g = 0; g < 4; g++) {
    const f1 = !!b.sides[0].activeRequest?.forceSwitch?.some(Boolean);
    const f2 = !!b.sides[1].activeRequest?.forceSwitch?.some(Boolean);
    if (!f1 && !f2) return;
    b.makeChoices(f1 ? 'default' : '', f2 ? 'default' : '');
  }
};
const pos = (p1: string[], seed = [5, 5, 5, 5]) => ({
  p1team: p1.map(mine), p2team: [gengar, incin, milotic],
  p1active: [0, 1], p2active: [0, 1], seed: seed as [number, number, number, number],
});

export async function probeFakeOut(): Promise<FakeOutFinding[]> {
  if (!(await ensureSimLoaded())) throw new Error('@pkmn/sim not installed');
  findings.length = 0;

  // === 1. Fake Out beats the whole turn-1 plan ============================
  {
    const b: any = buildBattle(pos(['Garchomp', 'Talonflame', 'Meowscarada']));
    const n = b.log.length;
    b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Tailwind')}`, 'move 1 mega, move 1 1');
    const flinched = b.log.slice(n).some((l: string) => l.includes('|cant|') && l.includes('flinch'));
    const eq = b.log.slice(n).some((l: string) => l.includes('|move|p1a: Garchomp|Earthquake'));
    say('Fake Out (+3) flinches Garchomp through the Scarf — Earthquake never happens',
      flinched && !eq,
      `flinched=${flinched}, Earthquake used=${eq}; my perish count = ${perishOf(b.sides[0].active[0])} — the song landed for free`);
  }

  // === 1b. Garchomp cannot even Protect the Fake Out ======================
  {
    const chompMoves = team.find(t => t.species === 'Garchomp')!.moves;
    const hasProtect = chompMoves.some(m => toId(m) === 'protect');
    const b: any = buildBattle(pos(['Talonflame', 'Garchomp', 'Meowscarada']));
    const n = b.log.length;
    // Talonflame DOES carry Protect, so it can refuse the flinch — Garchomp cannot.
    b.makeChoices(`move ${slot('Talonflame', 'Protect')}, move ${slot('Garchomp', 'Earthquake')}`, 'move 1 mega, move 1 1');
    const blocked = b.log.slice(n).some((l: string) => l.includes('|-activate|p1a: Talonflame|move: Protect'));
    say('Garchomp has NO Protect, so it cannot refuse the flinch — only eat it',
      !hasProtect && blocked,
      `Garchomp's moves are ${chompMoves.join('/')} — no Protect. Talonflame does carry one and blocked the ` +
      `Fake Out (${blocked}), but Protect does not stop the SONG: perish count ${perishOf(b.sides[0].active[1])}`);
  }

  // === 2. INTIMIDATE, not Fake Out, is what actually breaks the plan =======
  // Fake Out costs a turn. Intimidate costs the KO — and the standard Fake Out lead
  // brings both. Solo Earthquake at -1 is a NEAR-kill, which is the worst outcome:
  // it looks like the answer right up until it leaves the singer alive.
  {
    const survivors: number[] = [];
    let ko = 0;
    for (let i = 0; i < 16; i++) {
      const b: any = buildBattle(pos(['Garchomp', 'Talonflame', 'Meowscarada'],
        [i + 1, i * 3 + 2, i * 7 + 5, i * 11 + 3]));
      b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`, 'move 1 mega, move 1 1');
      b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`, 'move 2 1, move 2 1');
      const g = byBase(b.sides[1], 'Gengar');
      if (g.fainted) ko++; else survivors.push(Math.round(g.hp / g.maxhp * 100));
    }
    say('Intimidate breaks the solo Earthquake — it becomes a NEAR-kill, not a kill',
      ko <= 2,
      `KO on only ${ko}/16 seeds at -1 Atk; survivors sat on ${[...new Set(survivors)].sort((a, b) => a - b).join('/')}% ` +
      `— alive, and still able to sing`);
  }

  // === 3. Fix A: double up. Acrobatics converts the near-kill. =============
  {
    let ko = 0;
    for (let i = 0; i < 16; i++) {
      const b: any = buildBattle(pos(['Garchomp', 'Talonflame', 'Meowscarada'],
        [i + 1, i * 3 + 2, i * 7 + 5, i * 11 + 3]));
      b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`, 'move 1 mega, move 1 1');
      b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Acrobatics')} 1`, 'move 2 1, move 2 1');
      if (byBase(b.sides[1], 'Gengar').fainted) ko++;
    }
    say('FIX A — Earthquake + Acrobatics kills through Intimidate',
      ko === 16, `KO on ${ko}/16 seeds at -1 Atk; the leftover 1-16% is exactly what Acrobatics covers`);
  }

  // === 4. Fix B: Kingambit. Their Intimidate is a GIFT. ====================
  // Defiant answers an Attack drop with +2, so Incineroar's own ability leaves
  // Kingambit at a NET +1 — the one mon on the roster that wants to be Intimidated.
  {
    let ko = 0; let netBoost = 0;
    for (let i = 0; i < 16; i++) {
      const b: any = buildBattle(pos(['Kingambit', 'Talonflame', 'Garchomp'],
        [i + 1, i * 3 + 2, i * 7 + 5, i * 11 + 3]));
      b.makeChoices(`move ${slot('Kingambit', 'Kowtow Cleave')} 1, move ${slot('Talonflame', 'Protect')}`, 'move 1 mega, move 1 1');
      netBoost = b.sides[0].active[0].boosts.atk;
      b.makeChoices(`move ${slot('Kingambit', 'Kowtow Cleave')} 1, move ${slot('Talonflame', 'Protect')}`, 'move 2 1, move 2 1');
      if (byBase(b.sides[1], 'Gengar').fainted) ko++;
    }
    say('FIX B — Kingambit OHKOs it ALONE, because Defiant turns Intimidate into +1',
      ko === 16 && netBoost === 1,
      `Kingambit's net Atk stage after Intimidate = +${netBoost} (-1 then Defiant +2); ` +
      `Kowtow Cleave (Dark, 2x on Ghost) KOs on ${ko}/16 seeds with no help`);
  }

  // === 5. THE ADAPTED PLAN, end to end ====================================
  // Fake Out does not beat the plan, it DELAYS it. Song T1, kill T2, switch T3.
  {
    const b: any = buildBattle(pos(['Garchomp', 'Talonflame', 'Meowscarada', 'Pelipper']));
    b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`, 'move 1 mega, move 1 1');
    const count = perishOf(b.sides[0].active[0]);
    b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Acrobatics')} 1`, 'move 2 1, move 2 1');
    settle(b);
    const dead = byBase(b.sides[1], 'Gengar').fainted;
    const t = b.sides[0].active[0]?.trapped;
    const freed = t !== true && t !== 'hidden';
    b.makeChoices('switch 3, switch 4', 'move 2 1, move 2 1');
    const chomp = byBase(b.sides[0], 'Garchomp'), talon = byBase(b.sides[0], 'Talonflame');
    say('THE ADAPTED PLAN: eat the Fake Out, kill on T2, switch on T3 — nobody dies',
      dead && freed && perishOf(chomp) == null && perishOf(talon) == null && !chomp.fainted && !talon.fainted,
      `song landed T1 (count ${count}); trapper dead T2 = ${dead}; trap lifted = ${freed}; ` +
      `after the T3 switch both counts are ${perishOf(chomp)}/${perishOf(talon)} and both are alive`);
  }

  // === 6. How much slack? =================================================
  {
    const b: any = buildBattle(pos(['Garchomp', 'Talonflame', 'Meowscarada', 'Pelipper']));
    b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`, 'move 1 mega, move 1 1');
    let turns = 0;
    while (!byBase(b.sides[0], 'Garchomp').fainted && turns < 6) {
      b.makeChoices(`move ${slot('Garchomp', 'Rock Slide')}, move ${slot('Talonflame', 'Protect')}`, 'move 3, move 4');
      turns++;
    }
    say('The clock leaves exactly TWO turns of slack after the song',
      turns === 3,
      `the perished mon faints ${turns} turns after the song, so T2 (kill) and T3 (switch) both fit — ` +
      `a single Protect from Gengar on T2 spends the entire margin`);
  }

  // === 7. Does Sucker Punch beat Fake Out? ================================
  {
    const brackets = ['protect', 'fakeout', 'suckerpunch', 'acrobatics', 'perishsong', 'earthquake', 'uturn']
      .map(id => { const m: any = getMove(id); return `${m.name} ${m.priority >= 0 ? '+' : ''}${m.priority}`; });
    const b: any = buildBattle(pos(['Kingambit', 'Talonflame', 'Garchomp']));
    const n = b.log.length;
    b.makeChoices(`move ${slot('Kingambit', 'Sucker Punch')} 2, move ${slot('Talonflame', 'Protect')}`, 'move 1 mega, move 1 1');
    const order: string[] = b.log.slice(n)
      .filter((l: string) => l.startsWith('|move|') || l.startsWith('|cant|'))
      .map((l: string) => `${l.split('|')[2]?.split(': ')[1]}:${l.split('|')[3]}`);
    const flinched = order.some(o => o.startsWith('Kingambit') && o.includes('flinch'));
    say('Sucker Punch does NOT beat Fake Out — it is two brackets lower',
      flinched,
      `brackets: ${brackets.join(', ')}. Observed order: ${order.join(' -> ')} — ` +
      `Kingambit is flinched before Sucker Punch resolves, and it would fail into a status move anyway`);
  }

  // === 8. The stall line: they Protect the trapper on T2 ==================
  // Survival is EXACTLY "trapper dead by T3": if it lives to the start of T4 I am
  // still trapped for that choice and the count hits 0. So measure the kill.
  {
    const killRate = (protectAgainOnT3: boolean): number => {
      let ko = 0;
      const pair = `move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Acrobatics')} 1`;
      for (let i = 0; i < 40; i++) {
        const b: any = buildBattle(pos(['Garchomp', 'Talonflame', 'Meowscarada', 'Pelipper'],
          [i + 1, i * 3 + 2, i * 7 + 5, i * 11 + 3]));
        b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`, 'move 1 mega, move 1 1');
        b.makeChoices(pair, 'move 3, move 4');                                        // T2 they Protect
        b.makeChoices(pair, protectAgainOnT3 ? 'move 3, move 4' : 'move 2 1, move 2 1'); // T3
        if (byBase(b.sides[1], 'Gengar').fainted) ko++;
      }
      return ko;
    };
    const stalled = killRate(true), open = killRate(false);
    say('A T2 Protect does not beat the plan, but it spends the whole margin',
      open === 40 && stalled >= 24 && stalled < 40,
      `trapper dead by T3: ${stalled}/40 (${Math.round(stalled / 40 * 100)}%) if they Protect on T3 too, ` +
      `${open}/40 if they do not. So a repeat Protect is a straight ${Math.round((40 - stalled) / 40 * 100)}% chance ` +
      `of losing the mon — consecutive Protect usually FAILING is the only reason it is not 0%`);
  }

  // === 9. Partner flinched: what can Talonflame do alone? =================
  {
    const solo = (move: string): { ko: number; left: number[] } => {
      let ko = 0; const left: number[] = [];
      for (let i = 0; i < 40; i++) {
        const b: any = buildBattle(pos(['Talonflame', 'Garchomp', 'Meowscarada'],
          [i + 1, i * 3 + 2, i * 7 + 5, i * 11 + 3]));
        // Fake Out goes to my SLOT 2, so only Talonflame acts. Intimidate hit both.
        b.makeChoices(`move ${slot('Talonflame', move)} 1, move ${slot('Garchomp', 'Earthquake')}`, 'move 1 mega, move 1 2');
        const g = byBase(b.sides[1], 'Gengar');
        if (g.fainted) ko++; else left.push(Math.round(g.hp / g.maxhp * 100));
      }
      return { ko, left };
    };
    const acro = solo('Acrobatics'), blitz = solo('Flare Blitz');
    const rng = (a: number[]) => a.length ? `${Math.min(...a)}-${Math.max(...a)}%` : 'n/a';
    say('With the partner flinched, Talonflame alone cannot stop the song',
      acro.ko <= 4 && blitz.ko <= 4,
      `Acrobatics: KO ${acro.ko}/40, Gengar left on ${rng(acro.left)}. ` +
      `Flare Blitz: KO ${blitz.ko}/40, left on ${rng(blitz.left)}. ` +
      `Flare Blitz hits harder but costs recoil and drops Talonflame off full HP, losing Gale Wings priority`);
  }

  return findings;
}

if (process.argv[1]?.endsWith('perish-fakeout.ts')) {
  const f = await probeFakeOut();
  const bad = f.filter(x => !x.ok);
  console.log(`
${f.length - bad.length}/${f.length} expectations held.`);
  if (bad.length) { for (const b of bad) console.log(`  • ${b.headline}`); process.exit(1); }
}
