/**
 * perish-sim-probe.ts — run every claim `perishTrap.ts` makes through the REAL
 * Showdown engine (@pkmn/sim) and print ground truth.
 *
 * The advisory was written from mechanics reasoning plus one live game. That is
 * exactly the evidence mix that produces confident, wrong advice — its "KO the
 * trapper" out was already wrong once. Every escape route it names is a
 * falsifiable claim about the engine, so this settles each one for real.
 *
 * TWO HARNESS RULES, both learned by getting it wrong first:
 *
 *  1. A SELF-SWITCH IS NOT IMMEDIATE. U-turn / Baton Pass leave the battle in a
 *     `forceSwitch` request with the user still in the active slot. Reading
 *     `active[0]` right after the turn shows the mon "still in" and looks exactly
 *     like a failed escape. `pivot()` below completes the request before judging.
 *  2. NEVER LET THE OPPONENT PROTECT ON THE TEST TURN. A Protected U-turn deals
 *     no damage and does not switch — which reads as "trapping blocks pivots" and
 *     is not. The first run of this probe "proved" that and it was an artifact.
 *
 * Both are why each claim carries a CONTROL: the same line with the trap removed.
 * If the control doesn't behave, the harness is broken, not the mechanic.
 *
 * Exported as `probePerishTruth()` so `perish-sim-truth.test.ts` asserts exactly
 * these claims — the regression and the readable report stay one source.
 *
 *   npx tsx packages/core/src/scripts/perish-sim-probe.ts
 */
import { buildBattle, ensureSimLoaded, type SimMon, type SimPosition } from '../domain/simBridge.js';

// --- the cast (the live 2026-07-28 board) ----------------------------------
const gengar = (item = 'Gengarite'): SimMon => ({
  species: 'Gengar', ability: 'Cursed Body', item,
  moves: ['perishsong', 'shadowball', 'protect'], nature: 'Timid', evs: { spa: 252, spe: 252 },
});
const blastoise: SimMon = {
  species: 'Blastoise', ability: 'Torrent', item: 'Leftovers',
  moves: ['meanlook', 'surf', 'protect'], nature: 'Bold', evs: { hp: 252, def: 252 },
};
const milotic: SimMon = {
  species: 'Milotic', ability: 'Marvel Scale', item: 'Leftovers',
  moves: ['recover', 'scald', 'protect'], nature: 'Bold', evs: { hp: 252, def: 252 },
};
const chomp = (over: Partial<SimMon> = {}): SimMon => ({
  species: 'Garchomp', ability: 'Rough Skin', item: 'Life Orb',
  moves: ['dragonclaw', 'uturn', 'batonpass', 'protect'], nature: 'Jolly', evs: { atk: 252, spe: 252 },
  ...over,
});
const dnite: SimMon = {
  species: 'Dragonite', ability: 'Multiscale', item: 'Lum Berry',
  moves: ['extremespeed', 'protect'], nature: 'Adamant', evs: { hp: 252, atk: 252 },
};
const ttar: SimMon = {
  species: 'Tyranitar', ability: 'Sand Stream', item: 'Assault Vest',
  moves: ['crunch', 'protect'], nature: 'Adamant', evs: { hp: 252, atk: 252 },
};

const pos = (over: Partial<SimPosition> = {}): SimPosition => ({
  p1team: [chomp(), dnite, ttar], p2team: [gengar(), milotic],
  p1active: [0, 1], p2active: [0, 1], seed: [7, 7, 7, 7], ...over,
});

// --- engine readers --------------------------------------------------------
const perishOf = (p: any): number | null => p?.volatiles?.['perishsong']?.duration ?? null;
const byBase = (side: any, base: string) =>
  side.pokemon.find((p: any) => (p.species.baseSpecies || p.species.name) === base);
/** The engine's own answer to "can this mon switch out?". 'hidden' = trapped but
 *  concealed from the player's request; both truthy values mean trapped. */
const trappedFlag = (b: any, side = 0, slot = 0) => byActive(b, side, slot)?.trapped;
const byActive = (b: any, side = 0, slot = 0) => b.sides[side].active[slot];
const isTrapped = (b: any, side = 0, slot = 0) => {
  const t = trappedFlag(b, side, slot);
  return t === true || t === 'hidden';
};
/** Complete any pending faint/self-switch request on either side. Doubles hands
 *  these out at end of turn, and leaving one unanswered makes the NEXT
 *  makeChoices throw "Not all choices done" — which reads like a mechanic and is
 *  really just an unanswered prompt. `p2pick` is how the OPPONENT fills a slot my
 *  KO opened, which is the whole point of claim 7. */
const settle = (b: any, p1pick = 'default', p2pick = 'default'): void => {
  for (let guard = 0; guard < 4; guard++) {
    const f1 = !!b.sides[0].activeRequest?.forceSwitch?.some(Boolean);
    const f2 = !!b.sides[1].activeRequest?.forceSwitch?.some(Boolean);
    if (!f1 && !f2) return;
    b.makeChoices(f1 ? p1pick : '', f2 ? p2pick : '');
  }
};

/** Play a pivot move and COMPLETE the resulting forceSwitch (see harness rule 1). */
const pivot = (b: any, myChoice: string, theirChoice: string, replacement = 'switch 3'): boolean => {
  b.makeChoices(myChoice, theirChoice);
  if (!b.sides[0].activeRequest?.forceSwitch?.[0]) return false;
  b.makeChoices(replacement, 'default');
  return true;
};

export interface PerishClaim { claim: string; ok: boolean; detail: string }

/** Resolve every advisory claim against the real engine. One entry per claim;
 *  `ok === false` means the advisory is wrong about that mechanic. */
export async function probePerishTruth(opts: { log?: boolean } = {}): Promise<PerishClaim[]> {
  if (!(await ensureSimLoaded())) throw new Error('@pkmn/sim not installed — this probe needs the optional dep');
  const results: PerishClaim[] = [];
  const record = (claim: string, ok: boolean, detail: string) => {
    results.push({ claim, ok, detail });
    if (opts.log) console.log(`${ok ? '✓ CONFIRMED' : '✗ REFUTED  '}  ${claim}
              ${detail}`);
  };

  // Arm the standard position: song lands T1, Gengar megas T2 (Shadow Tag on).
  // T3 the opponent attacks the OTHER slot, so nothing Protects my pivot.
  const armed = (over: Partial<SimPosition> = {}) => {
    const b: any = buildBattle(pos(over));
    b.makeChoices('move 4, move 2', 'move 1, move 1');          // they sing
    b.makeChoices('move 4, move 2', 'move 2 mega 1, move 1');   // they mega → Shadow Tag
    return b;
  };

  // === 1. Mega Gengar really does bring Shadow Tag ============================
  {
    const b = armed();
    const g = byActive(b, 1);
    record('Mega Gengar has Shadow Tag (the base forme shows Cursed Body)',
      g.ability === 'shadowtag' && isTrapped(b),
      `species=${g.species.name} ability=${g.ability}; my mon trapped=${trappedFlag(b)}`);
  }

  // === 2. The song sets a 3-turn clock that actually kills ====================
  {
    const b: any = buildBattle(pos());
    b.makeChoices('move 4, move 2', 'move 1, move 1');
    const c0 = perishOf(byActive(b, 0));
    let turns = 0;
    while (!byBase(b.sides[0], 'Garchomp').fainted && turns < 5) {
      b.makeChoices('move 1 1, move 1 1', 'move 2 1, move 1'); turns++;
    }
    record('Perish Song sets a 3-turn clock that faints the mon',
      c0 === 3 && byBase(b.sides[0], 'Garchomp').fainted && turns === 3,
      `count when the song landed = ${c0}; Garchomp fainted on turn ${turns} after it`);
  }

  // === 3. Switching CLEARS your own count — why the trapper wins the race =====
  {
    const b: any = buildBattle(pos());
    b.makeChoices('move 4, move 2', 'move 1, move 1');
    const before = perishOf(byActive(b, 0));
    b.makeChoices('switch 3, move 2', 'move 2 1, move 1');
    const c = byBase(b.sides[0], 'Garchomp');
    record('Switching out CLEARS the perish count',
      before === 3 && perishOf(c) == null && !c.fainted,
      `count ${before} while in -> ${perishOf(c)} once benched (fainted=${c.fainted})`);
  }

  // === 4. U-turn escapes the trap AND clears the clock — the primary out ======
  // CONTROL FIRST. The first version of this probe reported U-turn as blocked; the
  // cause was the opponent Protecting, not the trap.
  {
    const ctrl: any = buildBattle(pos({ p2team: [gengar('Leftovers'), milotic] }));
    ctrl.makeChoices('move 4, move 2', 'move 1, move 1');
    ctrl.makeChoices('move 4, move 2', 'move 2 1, move 1');       // no mega → no trap
    const ctrlOut = pivot(ctrl, 'move 2 1, move 2', 'move 2 2, move 1');

    const b = armed();
    const escaped = pivot(b, 'move 2 1, move 2', 'move 2 2, move 1');
    const c = byBase(b.sides[0], 'Garchomp');
    record('U-turn escapes a Shadow Tag trap AND clears the count',
      ctrlOut && escaped && !c.isActive && perishOf(c) == null && !c.fainted,
      `control (no trap) escaped=${ctrlOut}; under Shadow Tag escaped=${escaped}, ` +
      `benched=${!c.isActive}, count now ${perishOf(c)}`);
  }

  // === 5. Baton Pass PASSES the count — the advisory's loudest ✗ ==============
  {
    const b = armed();
    const escaped = pivot(b, 'move 3, move 2', 'move 2 2, move 1');
    const gone = byBase(b.sides[0], 'Garchomp');
    const incoming = byActive(b, 0);
    record('Baton Pass escapes too — but hands the perish count to the incoming mon',
      escaped && !gone.isActive && perishOf(incoming) != null,
      `Garchomp left (count ${perishOf(gone)}), ${incoming.species.name} came in carrying ${perishOf(incoming)}`);
  }

  // === 6. Shed Shell / Ghost beat Shadow Tag; nothing else does ===============
  {
    const plain = armed();
    const shell = armed({ p1team: [chomp({ item: 'Shed Shell' }), dnite, ttar] });
    const gholdengo: SimMon = {
      species: 'Gholdengo', ability: 'Good as Gold', item: 'Leftovers',
      // Four moves with Protect in slot 4, so it accepts the same armed() line as the rest.
      moves: ['shadowball', 'nastyplot', 'recover', 'protect'], nature: 'Modest', evs: { hp: 252, spa: 252 },
    };
    const ghost = armed({ p1team: [gholdengo, dnite, ttar] });
    record('Shed Shell and Ghost typing free a mon from Shadow Tag; a plain mon stays trapped',
      isTrapped(plain) && !isTrapped(shell) && !isTrapped(ghost),
      `plain=${trappedFlag(plain)} shedShell=${trappedFlag(shell)} ghost=${trappedFlag(ghost)}`);
  }

  // === 7. THE USER'S CORRECTION ==============================================
  // "KO Blastoise was how Gengar managed to switch back in and keep me trapped."
  // This claim rewrote the advisory, so it is the one most worth proving.
  //
  // Two harness traps beyond the ones at the top of this file, both hit while
  // writing it: the `trapped` flag is only recomputed when a side gets a real move
  // request, so reading it while the opponent is mid-faint-switch returns a STALE
  // value; and if my attack rolls a crit it kills the returning Gengar, after which
  // "not trapped" is true for a reason that has nothing to do with the claim. So
  // the flag is read only after the refill settles, and I Protect on the mega turn
  // so the trapper cannot die.
  {
    const b: any = buildBattle(pos({ p2team: [blastoise, milotic, gengar()], p2active: [0, 1] }));
    b.makeChoices('move 4, move 2', 'move 1 1, move 1');          // Blastoise Mean Looks me
    const trappedByMove = isTrapped(b);

    byActive(b, 1).sethp(1);                                      // set up the KO
    b.makeChoices('move 1 1, move 1 1', 'move 2, move 1');        // Surf, not Protect — the KO lands
    const blast = byBase(b.sides[1], 'Blastoise');
    settle(b, 'default', 'switch 3');                             // THEY choose the replacement
    const freed = !isTrapped(b);                                  // read AFTER a fresh request
    const g = b.sides[1].active.find((p: any) => p && p.species.baseSpecies === 'Gengar');
    record('KOing the move-trapper frees me for a moment, but hands THEM the slot',
      trappedByMove && blast.fainted && freed && !!g,
      `Mean Look trapped=${trappedByMove}; Blastoise fainted=${blast.fainted}; freed by the KO=${freed}; ` +
      `they refilled with ${g ? g.species.name : 'nothing'}`);

    b.makeChoices('move 4, move 2', 'move 2 mega 1, move 1');     // I Protect; the refill megas
    const mega = byActive(b, 1);
    record('The returning Gengar re-applies the trap — the KO bought one turn',
      isTrapped(b) && mega?.ability === 'shadowtag',
      `${mega?.species.name} ability=${mega?.ability}; trapped again=${trappedFlag(b)}`);
  }

  // === 8. The counter that actually works: deny the song =====================
  {
    const whimsicott: SimMon = {
      species: 'Whimsicott', ability: 'Prankster', item: 'Focus Sash',
      moves: ['taunt', 'moonblast', 'protect'], nature: 'Timid', evs: { spa: 252, spe: 252 },
    };
    const b: any = buildBattle(pos({ p1team: [whimsicott, dnite, ttar] }));
    b.makeChoices('move 1 1, move 2', 'move 1, move 1');          // Prankster Taunt beats the song
    const g = byActive(b, 1);
    record('Taunting the singer denies Perish Song outright',
      !!g.volatiles['taunt'] && perishOf(byActive(b, 0)) == null,
      `Gengar taunted=${!!g.volatiles['taunt']}; my side's perish count=${perishOf(byActive(b, 0))}`);
  }

  return results;
}

// --- CLI -------------------------------------------------------------------
// Windows paths make a file:// comparison fussy; the basename is enough here.
if (process.argv[1]?.endsWith('perish-sim-probe.ts')) {
  const results = await probePerishTruth({ log: true });
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} claims confirmed against the real engine.`);
  if (bad.length) {
    console.log('REFUTED — the advisory is wrong about:');
    for (const r of bad) console.log(`  • ${r.claim}`);
    process.exit(1);
  }
}
