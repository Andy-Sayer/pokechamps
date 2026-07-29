/**
 * talonflame-perish-counter.ts — what THIS team actually does about a perish trap,
 * resolved through the real Showdown engine (@pkmn/sim).
 *
 * The generic advisory in `perishTrap.ts` lists escapes: pivot out, Shed Shell,
 * Ghost typing, Taunt the singer. Run against `TalonFlameAndyBoy.json` almost all
 * of them are unavailable — the team carries ONE pivot (Meowscarada's U-turn), no
 * Shed Shell, no Ghost, no Taunt, no Soundproof. Five of six mons cannot leave.
 *
 * So the counter for this team cannot be escape. It has to be DENIAL: kill or
 * outpace the singer before the song lands. This script tests the specific tools
 * this roster has, with its real spreads, rather than the general advice.
 *
 *   npx tsx packages/core/src/scripts/talonflame-perish-counter.ts
 */
import { readFileSync } from 'node:fs';
import { buildBattle, ensureSimLoaded, type SimMon, type SimPosition } from '../domain/simBridge.js';
import { toId } from '../domain/data.js';

interface TeamMon {
  species: string; item?: string | null; ability?: string | null; nature?: string;
  moves: string[]; evs?: Record<string, number>; ivs?: Record<string, number>;
}
const team: TeamMon[] = JSON.parse(readFileSync('data/my-teams/TalonFlameAndyBoy.json', 'utf8'));
const mine = (species: string, over: Partial<SimMon> = {}): SimMon => {
  const m = team.find(t => t.species === species);
  if (!m) throw new Error(`${species} not on the team`);
  return {
    species: m.species, ability: m.ability ?? undefined, item: m.item ?? '',
    moves: m.moves.map(toId), nature: m.nature ?? 'Hardy',
    evs: m.evs as SimMon['evs'], ivs: m.ivs as SimMon['ivs'], level: 50, ...over,
  };
};
/** Index of a move on one of my sets, 1-based, for choice strings. */
const slotOf = (species: string, move: string): number => {
  const m = team.find(t => t.species === species)!;
  const i = m.moves.findIndex(x => toId(x) === toId(move));
  if (i < 0) throw new Error(`${species} has no ${move}`);
  return i + 1;
};

// The threat: the live 2026-07-28 core. Gengar sings AND (post-mega) traps.
const gengar = (item = 'Gengarite'): SimMon => ({
  species: 'Gengar', ability: 'Cursed Body', item,
  moves: ['perishsong', 'shadowball', 'protect', 'destinybond'],
  nature: 'Timid', evs: { hp: 4, spa: 252, spe: 252 }, level: 50,
});
const blastoise: SimMon = {
  species: 'Blastoise', ability: 'Torrent', item: 'Leftovers',
  moves: ['meanlook', 'surf', 'protect', 'icebeam'],
  nature: 'Bold', evs: { hp: 252, def: 252, spd: 4 }, level: 50,
};

export interface CounterFinding { headline: string; ok: boolean; detail: string }
const findings: CounterFinding[] = [];
const say = (headline: string, ok: boolean, detail: string) => {
  findings.push({ headline, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${headline}\n    ${detail}`);
};

const perishOf = (p: any): number | null => p?.volatiles?.['perishsong']?.duration ?? null;
const byBase = (side: any, base: string) =>
  side.pokemon.find((p: any) => (p.species.baseSpecies || p.species.name) === base);
const isTrapped = (b: any, slot = 0) => {
  const t = b.sides[0].active[slot]?.trapped;
  return t === true || t === 'hidden';
};

export async function probeTalonflameCounters(opts: { log?: boolean } = {}): Promise<CounterFinding[]> {
  if (!(await ensureSimLoaded())) throw new Error('@pkmn/sim not installed');
  findings.length = 0;
  if (!opts.log) { /* keep console output but callers may ignore */ }

  // === SPEED: who actually moves first? ====================================
  {
    const b: any = buildBattle({
      p1team: [mine('Meowscarada'), mine('Talonflame'), mine('Garchomp')],
      p2team: [gengar(), blastoise], p1active: [0, 1], p2active: [0, 1], seed: [9, 9, 9, 9],
    });
    // NOT 'default': Talonflame's move 1 is TAILWIND, so a default choice doubles
    // my side's speed and the reading becomes nonsense (it read 384 for a mon whose
    // real L50 stat is 192). Everyone Protects instead.
    b.makeChoices(`move ${slotOf('Meowscarada', 'Protect')}, move ${slotOf('Talonflame', 'Protect')}`, 'move 2 mega 1, move 3');
    const g = b.sides[1].active[0];
    const spd = (p: any) => p.getStat('spe');
    const meow = byBase(b.sides[0], 'Meowscarada'), talon = byBase(b.sides[0], 'Talonflame');
    const chomp = byBase(b.sides[0], 'Garchomp');
    const scarf = Math.floor(spd(chomp) * 1.5);
    say('Mega Gengar outspeeds the team by a hair — but NOT the Scarf Garchomp',
      spd(g) > spd(talon) && spd(g) > spd(meow) && scarf > spd(g),
      `Gengar-Mega ${spd(g)} vs Talonflame ${spd(talon)}, Meowscarada ${spd(meow)} (both lose by <10), ` +
      `Garchomp+Scarf ${scarf} WINS. So the song lands first unless denied by priority, Tailwind, or the Scarf.`);
  }

  // === GALE WINGS: the one tool that beats the song without winning speed ===
  {
    const b: any = buildBattle({
      p1team: [mine('Talonflame'), mine('Meowscarada'), mine('Garchomp')],
      p2team: [gengar(), blastoise], p1active: [0, 1], p2active: [0, 1], seed: [9, 9, 9, 9],
    });
    const n = b.log.length;
    b.makeChoices(`move ${slotOf('Talonflame', 'Acrobatics')} 1, move ${slotOf('Meowscarada', 'Knock Off')} 1`, 'move 1, move 3');
    const order = b.log.slice(n).filter((l: string) => l.startsWith('|move|')).map((l: string) => l.split('|')[3]);
    const g = byBase(b.sides[1], 'Gengar');
    // The claim is that Acrobatics resolves before the SONG — not that it is first
    // overall (the foe's Protect legitimately precedes it, being +4 priority).
    const iAcro = order.indexOf('Acrobatics'), iSong = order.indexOf('Perish Song');
    say('Gale Wings Acrobatics resolves BEFORE Perish Song despite losing the speed race',
      iAcro >= 0 && (iSong === -1 || iAcro < iSong),
      `move order: ${order.join(' → ')}; the song ${iSong === -1 ? 'never happened' : 'came after'} — ` +
      `Gengar left on ${Math.round(g.hp / g.maxhp * 100)}%`);

    say('...and Acrobatics + Knock Off together KO the singer before it ever sings',
      g.fainted,
      g.fainted ? 'Gengar fainted on turn 1 — no song, no trap' :
        `Gengar SURVIVED on ${Math.round(g.hp / g.maxhp * 100)}% and got the song off (perish on my side = ${perishOf(b.sides[0].active[0])})`);
  }

  // === Talonflame ALONE — is the priority hit enough on its own? ===========
  {
    const b: any = buildBattle({
      p1team: [mine('Talonflame'), mine('Pelipper'), mine('Garchomp')],
      p2team: [gengar(), blastoise], p1active: [0, 1], p2active: [0, 1], seed: [9, 9, 9, 9],
    });
    b.makeChoices(`move ${slotOf('Talonflame', 'Acrobatics')} 1, move ${slotOf('Pelipper', 'Protect')}`, 'move 1, move 3');
    const g = byBase(b.sides[1], 'Gengar');
    say('Acrobatics ALONE does not KO — the song still lands if Talonflame acts solo',
      !g.fainted,
      `Gengar on ${Math.round(g.hp / g.maxhp * 100)}% after a priority Acrobatics; ` +
      `my side's perish count = ${perishOf(b.sides[0].active[0])} — it needs the second attacker`);
  }

  // === KNOCK OFF CANNOT REMOVE THE STONE (looks like a counter; is not) ====
  {
    const b: any = buildBattle({
      p1team: [mine('Meowscarada'), mine('Talonflame'), mine('Garchomp')],
      p2team: [gengar(), blastoise], p1active: [0, 1], p2active: [0, 1], seed: [9, 9, 9, 9],
    });
    b.makeChoices(`move ${slotOf('Meowscarada', 'Knock Off')} 1, move ${slotOf('Talonflame', 'Protect')}`, 'move 3, move 3');
    const g = byBase(b.sides[1], 'Gengar');
    say('Knock Off CANNOT remove Gengarite — a mega stone is not knockable',
      !!g.item && toId(g.item) === 'gengarite',
      `Gengar still holds ${g.item || '(nothing)'} after Knock Off — do not plan around stripping the stone`);
  }

  // === SUCKER PUNCH FAILS INTO A STATUS MOVE ==============================
  {
    const b: any = buildBattle({
      p1team: [mine('Kingambit'), mine('Talonflame'), mine('Garchomp')],
      p2team: [gengar(), blastoise], p1active: [0, 1], p2active: [0, 1], seed: [9, 9, 9, 9],
    });
    const n = b.log.length;
    b.makeChoices(`move ${slotOf('Kingambit', 'Sucker Punch')} 1, move ${slotOf('Talonflame', 'Protect')}`, 'move 1, move 3');
    const failed = b.log.slice(n).some((l: string) => l.startsWith('|-fail|p1a: Kingambit'));
    const g = byBase(b.sides[1], 'Gengar');
    say('Sucker Punch FAILS against Perish Song — the team\'s other priority is useless here',
      failed && !g.fainted,
      `Sucker Punch failed=${failed} (Perish Song is a status move); song landed, my count = ${perishOf(b.sides[0].active[0])}`);
  }

  // === TAILWIND flips the speed tier for the following turns ==============
  {
    const b: any = buildBattle({
      p1team: [mine('Talonflame'), mine('Meowscarada'), mine('Garchomp')],
      p2team: [gengar(), blastoise], p1active: [0, 1], p2active: [0, 1], seed: [9, 9, 9, 9],
    });
    b.makeChoices(`move ${slotOf('Talonflame', 'Tailwind')}, move ${slotOf('Meowscarada', 'Protect')}`, 'move 2 mega 1, move 3');
    const n = b.log.length;
    b.makeChoices(`move ${slotOf('Talonflame', 'Protect')}, move ${slotOf('Meowscarada', 'Knock Off')} 1`, 'move 1, move 3');
    const order: string[] = b.log.slice(n)
      .filter((l: string) => l.startsWith('|move|'))
      .map((l: string) => `${l.split('|')[2]?.split(': ')[1]}:${l.split('|')[3]}`);
    say('Under Tailwind, Meowscarada moves before Mega Gengar',
      order.findIndex(o => o.startsWith('Meowscarada')) < order.findIndex(o => o.startsWith('Gengar')),
      `order: ${order.join(' → ')}`);
  }

  // === IS THE DOUBLE-UP RELIABLE, OR DID ONE SEED FLATTER IT? =============
  // A single favourable roll is not a plan. 16 seeds, and separately against a
  // Gengar that has ALREADY megaed (Mega Gengar is bulkier: 60/80/95 vs 60/60/75).
  {
    const koRate = (alreadyMega: boolean): number => {
      let ko = 0;
      for (let i = 0; i < 16; i++) {
        const b: any = buildBattle({
          p1team: [mine('Talonflame'), mine('Meowscarada'), mine('Garchomp')],
          p2team: [gengar(), blastoise], p1active: [0, 1], p2active: [0, 1],
          seed: [i + 1, i * 3 + 2, i * 7 + 5, i * 11 + 3],
        });
        if (alreadyMega) {
          b.makeChoices(`move ${slotOf('Talonflame', 'Protect')}, move ${slotOf('Meowscarada', 'Protect')}`, 'move 2 mega 1, move 3');
        }
        b.makeChoices(`move ${slotOf('Talonflame', 'Acrobatics')} 1, move ${slotOf('Meowscarada', 'Knock Off')} 1`, 'move 1, move 3');
        if (byBase(b.sides[1], 'Gengar').fainted) ko++;
      }
      return ko;
    };
    const base = koRate(false), mega = koRate(true);
    say('The Acrobatics + Knock Off double-up is a RELIABLE kill, not a lucky roll',
      base === 16,
      `KO on ${base}/16 seeds vs base Gengar; ${mega}/16 vs an ALREADY-MEGA Gengar ` +
      `(Mega is bulkier: 80 Def / 95 SpD vs 60 / 75) — so hit it BEFORE it megas if you can`);
  }

  // === THE SCARF SPEED WIN, CONVERTED ====================================
  // Garchomp+Scarf (231) beats Mega Gengar (200), and Ground is 2x on Poison.
  // The usual objection to Earthquake in doubles is that it hits your partner —
  // but THREE of this team's five other mons are Flying and simply ignore it.
  {
    let ko = 0, partnerHurt = 0;
    for (let i = 0; i < 16; i++) {
      const b: any = buildBattle({
        p1team: [mine('Garchomp'), mine('Talonflame'), mine('Pelipper')],
        p2team: [gengar(), blastoise], p1active: [0, 1], p2active: [0, 1],
        seed: [i + 1, i * 3 + 2, i * 7 + 5, i * 11 + 3],
      });
      b.makeChoices(`move ${slotOf('Garchomp', 'Earthquake')}, move ${slotOf('Talonflame', 'Tailwind')}`, 'move 2 mega 1, move 3');
      if (byBase(b.sides[1], 'Gengar').fainted) ko++;
      const talon = byBase(b.sides[0], 'Talonflame');
      if (talon.hp < talon.maxhp) partnerHurt++;
    }
    say('Scarf Garchomp Earthquake OHKOs Mega Gengar, and a Flying partner is untouched',
      ko === 16 && partnerHurt === 0,
      `OHKO on ${ko}/16 seeds even through the mega; Talonflame took damage on ${partnerHurt}/16 ` +
      `(Flying is immune to Ground — Talonflame, Pelipper and Dragonite all sit beside it safely)`);
  }

  // === THE ESCAPE THAT EXISTS, AND THE ONE THAT DOESN'T ===================
  {
    const b: any = buildBattle({
      p1team: [mine('Meowscarada'), mine('Talonflame'), mine('Garchomp')],
      p2team: [gengar(), blastoise], p1active: [0, 1], p2active: [0, 1], seed: [9, 9, 9, 9],
    });
    b.makeChoices('move 3, move 4', 'move 1, move 3');                 // song lands
    b.makeChoices('move 3, move 4', 'move 2 mega 1, move 3');          // mega → Shadow Tag
    const trapped = isTrapped(b);
    b.makeChoices(`move ${slotOf('Meowscarada', 'U-turn')} 1, move ${slotOf('Talonflame', 'Protect')}`, 'move 2 2, move 3');
    const pending = !!b.sides[0].activeRequest?.forceSwitch?.[0];
    if (pending) b.makeChoices('switch 3', 'default');
    const meow = byBase(b.sides[0], 'Meowscarada');
    say('Meowscarada U-turn IS a real escape from Shadow Tag (the team\'s only one)',
      trapped && pending && !meow.isActive && perishOf(meow) == null,
      `trapped=${trapped}; U-turn switched it out=${pending}; count cleared=${perishOf(meow) == null}`);
  }
  {
    const b: any = buildBattle({
      p1team: [mine('Garchomp'), mine('Talonflame'), mine('Pelipper')],
      p2team: [gengar(), blastoise], p1active: [0, 1], p2active: [0, 1], seed: [9, 9, 9, 9],
    });
    // Dragon Claw at the OTHER slot, not Earthquake: EQ hits Gengar super-effectively
    // and killed it outright, which ends the scenario before it can demonstrate anything.
    b.makeChoices(`move ${slotOf('Garchomp', 'Dragon Claw')} 2, move ${slotOf('Talonflame', 'Protect')}`, 'move 1, move 3');
    b.makeChoices(`move ${slotOf('Garchomp', 'Dragon Claw')} 2, move ${slotOf('Talonflame', 'Protect')}`, 'move 2 mega 1, move 3');
    const chomp = byBase(b.sides[0], 'Garchomp');
    say('Scarf Garchomp has NO out — it is simply dead once trapped',
      isTrapped(b) && perishOf(chomp) != null,
      `trapped=${b.sides[0].active[0]?.trapped}, perish=${perishOf(chomp)}, ` +
      `moves=${team.find(t => t.species === 'Garchomp')!.moves.join('/')} — no pivot, no Shed Shell, not Ghost`);
  }

  return findings;
}

if (process.argv[1]?.endsWith('talonflame-perish-counter.ts')) {
  const f = await probeTalonflameCounters({ log: true });
  const bad = f.filter(x => !x.ok);
  console.log(`\n${f.length - bad.length}/${f.length} expectations held.`);
  if (bad.length) { for (const b of bad) console.log(`  • ${b.headline}`); process.exit(1); }
}
