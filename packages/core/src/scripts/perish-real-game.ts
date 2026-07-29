/**
 * perish-real-game.ts — the perish trap AS IT ACTUALLY HAPPENED, 2026-07-28.
 *
 * Reconstructed from matches/1785221959416.json plus the vision banner log, after
 * the earlier analysis turned out to be modelling a board that never existed. The
 * corrections, all of which changed the answer:
 *
 *   ASSUMED                             REALITY
 *   Blastoise = Mean Look trapper       Blastoise = FAKE OUT (knownMoves proves it)
 *   Fake Out came from Incineroar       came from Blastoise; Incineroar not brought
 *   Intimidate dropped my Attack        NO Intimidate anywhere — Blastoise has none
 *   Gengar had Shadow Ball              Gengar had DESTINY BOND
 *   the song was cast once              cast TWICE — they withdrew Gengar to clear
 *                                       its own count, brought it back, sang again
 *   Kingambit was available             NOT BROUGHT. Bring was Talonflame, Garchomp,
 *                                       Meowscarada, Dragonite
 *
 * The banner log timeline:
 *   07:00:23  song lands, all four on 3
 *   07:02:15  "Omar withdrew Gengar!"        <- rotates out to clear its own clock
 *   07:03:42  Garchomp perish 0             <- faints
 *   07:03:50  Dragonite perish 0            <- faints
 *   07:05:01  Gengar perish 3               <- SECOND song, catching Talonflame + Meowscarada
 *   07:06:01  "took its attacker down with it"  <- Destiny Bond trades for another
 *
 * The point of this file is that Gengar is FASTER than everything I brought except
 * the Choice Scarf Garchomp — so the Scarf is the only thing that beats the song,
 * and the Fake Out exists precisely to switch the Scarf off for one turn.
 *
 *   npx tsx packages/core/src/scripts/perish-real-game.ts
 */
import { readFileSync } from 'node:fs';
import { buildBattle, ensureSimLoaded, type SimMon } from '../domain/simBridge.js';
import { toId } from '../domain/data.js';

interface TeamMon {
  species: string; item?: string | null; ability?: string | null; nature?: string;
  moves: string[]; evs?: Record<string, number>;
}
const team: TeamMon[] = JSON.parse(readFileSync('data/my-teams/TalonFlameAndyBoy.json', 'utf8'));
const mine = (species: string): SimMon => {
  const m = team.find(t => t.species === species);
  if (!m) throw new Error(`${species} not on the team`);
  return {
    species: m.species, ability: m.ability ?? undefined, item: m.item ?? '',
    moves: m.moves.map(toId), nature: m.nature ?? 'Hardy', evs: m.evs as SimMon['evs'], level: 50,
  };
};
const slot = (species: string, move: string): number => {
  const m = team.find(t => t.species === species)!;
  const i = m.moves.findIndex(x => toId(x) === toId(move));
  if (i < 0) throw new Error(`${species} has no ${move}`);
  return i + 1;
};

// THE REAL OPPONENT. Perish Song and Destiny Bond are confirmed from the game;
// Shadow Ball and Protect are the standard filler for the archetype.
const gengar: SimMon = {
  species: 'Gengar', ability: 'Cursed Body', item: 'Gengarite',
  moves: ['perishsong', 'destinybond', 'shadowball', 'protect'],
  nature: 'Timid', evs: { hp: 4, spa: 252, spe: 252 }, level: 50,
};
// Fake Out is confirmed. Torrent, NOT Intimidate — this is the correction that
// mattered most, because the whole -1 Attack analysis simply did not apply.
const blastoise: SimMon = {
  species: 'Blastoise', ability: 'Torrent', item: 'Leftovers',
  moves: ['fakeout', 'surf', 'icebeam', 'protect'],
  nature: 'Bold', evs: { hp: 252, def: 252, spd: 4 }, level: 50,
};

// opponentBrought in the snapshot is [Blastoise, Gengar] because it only records what
// was REVEALED before the log stopped — it grows 2->4 over a match. The other two come
// from their preview team so the sim can continue past a KO.
const incin: SimMon = {
  species: 'Incineroar', ability: 'Intimidate', item: 'Safety Goggles',
  moves: ['fakeout', 'knockoff', 'flareblitz', 'partingshot'],
  nature: 'Careful', evs: { hp: 252, atk: 4, spd: 252 }, level: 50,
};
const archaludon: SimMon = {
  species: 'Archaludon', ability: 'Stamina', item: 'Assault Vest',
  moves: ['electroshot', 'dracometeor', 'flashcannon', 'bodypress'],
  nature: 'Modest', evs: { hp: 252, spa: 252, spd: 4 }, level: 50,
};

export interface RealFinding { headline: string; ok: boolean; detail: string }
const findings: RealFinding[] = [];
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
// The bring that actually happened: Talonflame, Garchomp, Meowscarada, Dragonite.
const pos = (leads: string[], seed = [5, 5, 5, 5]) => ({
  p1team: leads.map(mine), p2team: [gengar, blastoise, incin, archaludon],
  p1active: [0, 1], p2active: [0, 1], seed: seed as [number, number, number, number],
});
const BRING = ['Garchomp', 'Talonflame', 'Meowscarada', 'Dragonite'];

export async function probeRealGame(): Promise<RealFinding[]> {
  if (!(await ensureSimLoaded())) throw new Error('@pkmn/sim not installed');
  findings.length = 0;

  // === 1. Only the Scarf beats Mega Gengar ================================
  {
    const b: any = buildBattle(pos(BRING));
    // Mega it first — the comparison that matters is against Gengar-MEGA (130 base),
    // not the 110-base forme. And getStat ALREADY applies the Choice Scarf to an active
    // mon; multiplying by 1.5 again reported Garchomp at 346.
    b.makeChoices(`move ${slot('Garchomp', 'Rock Slide')}, move ${slot('Talonflame', 'Protect')}`, 'move 4 mega, move 4');
    const spd = (p: any) => p.getStat('spe');
    const g = b.sides[1].active[0];
    const bench = (s: string) => {
      const p = byBase(b.sides[0], s);
      const scarf = /choice ?scarf/i.test(String(team.find(t => t.species === s)?.item));
      // Active mons already have the item applied; benched ones do not.
      return b.sides[0].active.includes(p) || !scarf ? spd(p) : Math.floor(spd(p) * 1.5);
    };
    const speeds = BRING.map(s => `${s} ${bench(s)}`);
    const faster = BRING.filter(s => bench(s) > spd(g));
    say('Of everything I brought, ONLY the Scarf Garchomp outruns Mega Gengar',
      faster.length === 1 && faster[0] === 'Garchomp',
      `Gengar-Mega ${spd(g)} vs ${speeds.join(', ')}. Faster than it: ${faster.join(', ') || 'nothing'} — ` +
      `the Choice Scarf is the entire answer, which is exactly why the Fake Out is aimed at it`);
  }

  // === 2. Fake Out from BLASTOISE switches the Scarf off for a turn =======
  {
    const b: any = buildBattle(pos(BRING));
    const n = b.log.length;
    b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Tailwind')}`, 'move 1 mega, move 1 1');
    const flinched = b.log.slice(n).some((l: string) => l.includes('|cant|') && l.includes('flinch'));
    say('Blastoise Fake Out flinches Garchomp and the song lands — this is the whole loss',
      flinched && perishOf(b.sides[0].active[0]) === 3,
      `flinched=${flinched}; Garchomp perish=${perishOf(b.sides[0].active[0])}, ` +
      `Talonflame perish=${perishOf(b.sides[0].active[1])} — matches the 07:00:23 banner exactly`);
  }

  // === 3. WITHOUT Intimidate the Earthquake is a clean OHKO ===============
  // The earlier analysis had this failing at -1. There was no Intimidate in this
  // game, so the kill is clean and the whole "near-kill" problem evaporates.
  {
    let ko = 0;
    for (let i = 0; i < 40; i++) {
      const b: any = buildBattle(pos(BRING, [i + 1, i * 3 + 2, i * 7 + 5, i * 11 + 3]));
      b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`, 'move 1 mega, move 1 1');
      b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`, 'move 3 1, move 2');
      if (byBase(b.sides[1], 'Gengar').fainted) ko++;
    }
    say('With no Intimidate in play, Earthquake OHKOs Mega Gengar cleanly on T2',
      ko === 40, `KO on ${ko}/40 seeds — Blastoise has Torrent, not Intimidate, so Garchomp swings at full Attack`);
  }

  // === 4. DESTINY BOND: does killing it cost me a mon? ===================
  // Destiny Bond is priority 0 and only binds if the user is KO'd AFTER setting it.
  // Garchomp+Scarf (231) moves before Gengar (200), so the KO lands first and the
  // bond is never set. The speed win beats Destiny Bond as well as the song.
  {
    let ko = 0, traded = 0;
    for (let i = 0; i < 40; i++) {
      const b: any = buildBattle(pos(BRING, [i + 1, i * 3 + 2, i * 7 + 5, i * 11 + 3]));
      b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`, 'move 1 mega, move 1 1');
      b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`, 'move 2, move 2'); // Gengar clicks DESTINY BOND
      if (byBase(b.sides[1], 'Gengar').fainted) ko++;
      if (byBase(b.sides[0], 'Garchomp').fainted) traded++;
    }
    say('Garchomp outspeeds the Destiny Bond too — the KO lands before the bond is set',
      ko === 40 && traded === 0,
      `Gengar clicked Destiny Bond on T2: KO ${ko}/40, and Garchomp was dragged down ${traded}/40 times. ` +
      `Scarf 231 > Gengar 200, so the bond never gets set`);
  }

  // === 5. THE LINE THAT SAVES THE GAME ===================================
  {
    const b: any = buildBattle(pos(BRING));
    b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Tailwind')}`, 'move 1 mega, move 1 1');
    const c1 = perishOf(b.sides[0].active[0]);
    b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`, 'move 2, move 2');
    settle(b);
    const dead = byBase(b.sides[1], 'Gengar').fainted;
    const t = b.sides[0].active[0]?.trapped;
    const freed = t !== true && t !== 'hidden';
    b.makeChoices('switch 3, switch 4', 'move 2 1, move 2');
    const chomp = byBase(b.sides[0], 'Garchomp'), talon = byBase(b.sides[0], 'Talonflame');
    say('T1 eat the flinch, T2 Earthquake the Gengar, T3 switch out — nobody dies',
      dead && freed && perishOf(chomp) == null && perishOf(talon) == null && !chomp.fainted && !talon.fainted,
      `T1 song (count ${c1}); T2 Gengar dead=${dead}, trap lifted=${freed}; T3 both counts cleared ` +
      `(${perishOf(chomp)}/${perishOf(talon)}), both alive. And a dead Gengar cannot come back for the SECOND song`);
  }

  // === 6. What the switch on T1 actually cost =============================
  // In the real game I switched Talonflame out for Dragonite on T1. Switches resolve
  // BEFORE moves, so Dragonite walked straight into the song — it did not dodge it.
  {
    const b: any = buildBattle(pos(BRING));
    b.makeChoices(`move ${slot('Garchomp', 'Earthquake')}, switch 4`, 'move 1 mega, move 1 1');
    const dnite = byBase(b.sides[0], 'Dragonite');
    const talon = byBase(b.sides[0], 'Talonflame');
    say('Switching on the song turn does NOT dodge it — the incoming mon is caught',
      perishOf(dnite) === 3 && perishOf(talon) == null,
      `Dragonite switched in and immediately took perish ${perishOf(dnite)}; Talonflame escaped with ${perishOf(talon)}. ` +
      `Switches resolve before moves, so the replacement hears the song — exactly what happened at 07:00:23`);
  }

  return findings;
}

if (process.argv[1]?.endsWith('perish-real-game.ts')) {
  const f = await probeRealGame();
  const bad = f.filter(x => !x.ok);
  console.log(`\n${f.length - bad.length}/${f.length} expectations held.`);
  if (bad.length) { for (const b of bad) console.log(`  • ${b.headline}`); process.exit(1); }
}
