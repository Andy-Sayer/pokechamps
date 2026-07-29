/**
 * perish-walkthrough.ts — the classic perish trap and the counter, played out
 * turn by turn against the real Showdown engine with the TalonFlameAndyBoy sets.
 *
 * Three lines, all resolved by @pkmn/sim rather than described:
 *   A. THE TRAP, executed properly against a natural-looking line — the loss.
 *   B. THE COUNTER — Scarf Garchomp removes the singer before it ever sings.
 *   C. THE RECOVERY — what is left once the song has already landed.
 *
 *   npx tsx packages/core/src/scripts/perish-walkthrough.ts
 */
import { readFileSync } from 'node:fs';
import { buildBattle, ensureSimLoaded, type SimMon } from '../domain/simBridge.js';
import { toId } from '../domain/data.js';

interface TeamMon {
  species: string; item?: string | null; ability?: string | null; nature?: string;
  moves: string[]; evs?: Record<string, number>; ivs?: Record<string, number>;
}
const team: TeamMon[] = JSON.parse(readFileSync('data/my-teams/TalonFlameAndyBoy.json', 'utf8'));
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
const blastoise: SimMon = {
  species: 'Blastoise', ability: 'Torrent', item: 'Leftovers',
  moves: ['meanlook', 'surf', 'protect', 'icebeam'],
  nature: 'Bold', evs: { hp: 252, def: 252, spd: 4 }, level: 50,
};
const milotic: SimMon = {
  species: 'Milotic', ability: 'Marvel Scale', item: 'Leftovers',
  moves: ['recover', 'scald', 'protect', 'icebeam'],
  nature: 'Bold', evs: { hp: 252, def: 252, spd: 4 }, level: 50,
};

// --- narration -------------------------------------------------------------
const NAME = (s: string) => s.replace(/^p\d[ab]: /, '');
function narrate(b: any, from: number): string[] {
  const out: string[] = [];
  for (const line of b.log.slice(from)) {
    const f = line.split('|').slice(1);
    switch (f[0]) {
      case 'move': {
        const target = f[3] && f[2] !== 'Perish Song' ? '' : '';
        out.push(`    ${NAME(f[1] ?? '')} used ${f[2]}${target}`); break;
      }
      case 'detailschange':
        // A fainted mega reverts with a slot-less "p2: Gengar" entry — noise, not an event.
        if (!/^p\d[ab]: /.test(f[1] ?? '')) break;
        out.push(`    ${NAME(f[1] ?? '')} MEGA EVOLVED -> ${f[2]?.split(',')[0]}`); break;
      case '-ability': out.push(`      ability revealed: ${f[2]}`); break;
      case 'switch': out.push(`    >> ${NAME(f[1] ?? '')} switched in`); break;
      case '-damage': {
        if (f[2]?.includes('fnt')) break;
        const from2 = f[3] ? ` (${f[3].replace('[from] ', '')})` : '';
        out.push(`      ${NAME(f[1] ?? '')} -> ${f[2]}${from2}`); break;
      }
      case '-start': if (f[2]?.startsWith('perish')) out.push(`      ${NAME(f[1] ?? '')} perish count ${f[2]!.replace('perish', '')}`); break;
      case '-activate': out.push(`      ${NAME(f[1] ?? '')} ${f[2]?.replace('move: ', '')}`); break;
      case '-fail': out.push(`      ${NAME(f[1] ?? '')} FAILED`); break;
      case '-immune': out.push(`      ${NAME(f[1] ?? '')} is immune`); break;
      case '-supereffective': out.push('      super effective!'); break;
      case 'faint': out.push(`    *** ${NAME(f[1] ?? '')} FAINTED ***`); break;
      case '-fieldstart': out.push(`      ${f[1]?.replace('move: ', '')} is up`); break;
    }
  }
  // The engine emits state lines once per side, so a doubles perish block arrives
  // twice (in different orders). Collapse repeats within this turn, keeping order.
  const seen = new Set<string>();
  return out.filter((l, i) => {
    if (l !== out[i - 1] && !/perish count|-> \d+\/\d+$/.test(l)) return true;
    if (l === out[i - 1]) return false;
    if (seen.has(l)) return false;
    seen.add(l); return true;
  });
}

interface Turn { title: string; mine: string; theirs: string; note?: string }

function play(title: string, p1team: SimMon[], p2team: SimMon[], turns: Turn[]) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  const b: any = buildBattle({ p1team, p2team, p1active: [0, 1], p2active: [0, 1], seed: [5, 5, 5, 5] });
  console.log(`  Mine:   ${p1team.slice(0, 2).map(m => m.species).join(' + ')}   (bench: ${p1team.slice(2).map(m => m.species).join(', ')})`);
  console.log(`  Theirs: ${p2team.slice(0, 2).map(m => m.species).join(' + ')}`);
  for (const t of turns) {
    const n = b.log.length;
    try {
      b.makeChoices(t.mine, t.theirs);
      // A KO leaves a forceSwitch request; answering it here keeps the walkthrough
      // going instead of dying on "Not all choices done" one turn later.
      for (let g = 0; g < 3; g++) {
        const f1 = !!b.sides[0].activeRequest?.forceSwitch?.some(Boolean);
        const f2 = !!b.sides[1].activeRequest?.forceSwitch?.some(Boolean);
        if (!f1 && !f2) break;
        b.makeChoices(f1 ? 'default' : '', f2 ? 'default' : '');
      }
    } catch (e) {
      console.log(`\n  ${t.title}\n    (line ends: ${(e as Error).message})`);
      break;
    }
    console.log(`\n  ${t.title}`);
    for (const l of narrate(b, n)) console.log(l);
    if (t.note) console.log(`    -> ${t.note}`);
  }
  const dead = b.sides[0].pokemon.filter((p: any) => p.fainted).map((p: any) => p.species.name);
  const theirDead = b.sides[1].pokemon.filter((p: any) => p.fainted).map((p: any) => p.species.name);
  console.log(`\n  RESULT — I lost: ${dead.length ? dead.join(', ') : 'nothing'} | they lost: ${theirDead.length ? theirDead.join(', ') : 'nothing'}`);
  return b;
}

if (!(await ensureSimLoaded())) { console.error('@pkmn/sim not installed'); process.exit(1); }

const myLead = [mine('Garchomp'), mine('Talonflame'), mine('Meowscarada'), mine('Pelipper')];

// ===========================================================================
play(
  'A.  THE CLASSIC TRAP — how it kills you, playing the natural-looking line',
  myLead, [gengar, blastoise, milotic],
  [
    { title: 'TURN 1 — I hit the thing that looks threatening. Gengar megas.',
      mine: `move ${slot('Garchomp', 'Dragon Claw')} 2, move ${slot('Talonflame', 'Tailwind')}`,
      theirs: 'move 2 mega 1, move 3',
      note: 'The Scarf just locked Garchomp into Dragon Claw. Shadow Tag is now on — Garchomp cannot leave, and can never click Earthquake again.' },
    { title: 'TURN 2 — the song lands. Both my actives are on the clock.',
      mine: `move ${slot('Garchomp', 'Dragon Claw')} 2, move ${slot('Talonflame', 'Acrobatics')} 1`,
      theirs: 'move 1, move 3',
      note: 'Everyone on the field is on 3 — including their own two. The difference is that THEY can switch to clear it.' },
    { title: 'TURN 3 — they stall. I cannot leave.',
      mine: `move ${slot('Garchomp', 'Dragon Claw')} 2, move ${slot('Talonflame', 'Acrobatics')} 1`,
      theirs: 'move 3, move 3' },
    { title: 'TURN 4 — they rotate their own mons out to clear THEIR counts.',
      mine: `move ${slot('Garchomp', 'Dragon Claw')} 2, move ${slot('Talonflame', 'Acrobatics')} 1`,
      theirs: 'switch 3, move 3',
      note: 'Gengar leaving lifts Shadow Tag — but my choice for this turn was already locked in while it was still on.' },
    { title: 'TURN 5 — the clock reaches zero.',
      mine: `move ${slot('Garchomp', 'Dragon Claw')} 2, move ${slot('Talonflame', 'Acrobatics')} 1`,
      theirs: 'move 1, move 3' },
  ],
);

// ===========================================================================
play(
  'B.  THE COUNTER — Scarf Garchomp deletes the singer on turn 1',
  myLead, [gengar, blastoise, milotic],
  [
    { title: 'TURN 1 — Earthquake. Garchomp+Scarf (231) moves before Mega Gengar (200).',
      mine: `move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Tailwind')}`,
      theirs: 'move 2 mega 1, move 3',
      note: 'Ground is 2x on Poison, and Talonflame is FLYING so the spread does not touch it. No singer, no song, no trap.' },
    { title: 'TURN 2 — nothing left to sing. Tailwind is up and I am ahead.',
      mine: `move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Acrobatics')} 1`,
      theirs: 'move 2 1, move 3',
      note: 'Compare line A: there I lost both actives and they lost one mon. Here the trap never existed.' },
  ],
);

// ===========================================================================
play(
  'C.  THE RECOVERY — the song already landed. One escape exists.',
  [mine('Meowscarada'), mine('Talonflame'), mine('Garchomp'), mine('Pelipper')],
  [gengar, blastoise, milotic],
  [
    { title: 'TURN 1 — they mega and sing. I am on the clock.',
      mine: `move ${slot('Meowscarada', 'Protect')}, move ${slot('Talonflame', 'Protect')}`,
      theirs: 'move 1 mega, move 3',
      note: 'Shadow Tag is on and the count is running. BOTH are stuck — Talonflame is Fire/Flying, which does nothing against Shadow Tag (only Ghost typing or Shed Shell would).' },
    { title: 'TURN 2 — U-turn is the ONLY escape on this team, and it clears the count.',
      mine: `move ${slot('Meowscarada', 'U-turn')} 1, move ${slot('Talonflame', 'Protect')}`,
      theirs: 'move 2 2, move 3',
      note: 'A pivot move switches through Shadow Tag; leaving the field wipes the perish counter. Garchomp comes in CLEAN — no count.' },
    { title: 'TURN 3 — Talonflame has no pivot, so it just waits to die.',
      mine: `move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`,
      theirs: 'move 3, move 3' },
    { title: 'TURN 4 — the clock runs out on the one that could not leave.',
      mine: `move ${slot('Garchomp', 'Earthquake')}, move ${slot('Talonflame', 'Protect')}`,
      theirs: 'move 3, move 3',
      note: 'One saved, one lost. That is the BEST this team does once the song has landed — which is why the answer is to deny the song, not to survive it.' },
  ],
);

console.log('\nAll three lines resolved by @pkmn/sim, not asserted.\n');
