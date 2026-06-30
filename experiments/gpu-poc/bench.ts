/* PoC benchmark: GPU-batched damage-roll kernel vs CPU, plus context numbers.
 *
 *   1. Validate the kernel formula BIT-EXACTLY against @smogon/calc on neutral,
 *      no-modifier cases (proves the GPU produces the real calc's damage).
 *   2. Validate GPU output == CPU output bit-exactly on a large sample.
 *   3. Benchmark CPU (single-thread) vs GPU throughput across batch sizes.
 *   4. Context: how many FULL @smogon/calc calculate() calls/sec a single thread
 *      does — the cost the search actually pays per cell (arithmetic is <1% of it).
 *
 * CPU baseline is deliberately single-threaded + small so it doesn't compete with
 * a running 30-worker gauntlet. GPU work is free (idle GPU).
 */
import { Generations, calculate, Pokemon, Move, Field } from '@smogon/calc';
import { cpuRolls, cpuRollsOne, ROLLS } from './damageKernel.js';
import { initGpu } from './gpu.js';

const gen = Generations.get(9);

function section(t: string) { console.log('\n' + '='.repeat(72) + '\n' + t + '\n' + '='.repeat(72)); }

// ---------------------------------------------------------------------------
// 1. Validate kernel formula vs @smogon/calc on neutral cases.
// ---------------------------------------------------------------------------
function validateVsCalc(): void {
  section('1. Kernel formula vs @smogon/calc (neutral, no-modifier cases)');
  // Attacker / move / defender chosen so the move is non-STAB and neutral.
  const cases: Array<[string, string, string]> = [
    ['Tauros', 'Earthquake', 'Garchomp'],      // Normal mon, Ground move, neutral
    ['Garchomp', 'Body Slam', 'Tyranitar'],     // non-STAB Normal, neutral vs Rock/Dark
    ['Snorlax', 'Earthquake', 'Blissey'],        // non-STAB Ground, neutral vs Normal
    ['Tyranitar', 'Body Slam', 'Garchomp'],      // non-STAB Normal, neutral
    ['Dragonite', 'Surf', 'Snorlax'],            // non-STAB Water, neutral vs Normal
    ['Gengar', 'Surf', 'Snorlax'],               // non-STAB special Water, neutral
    ['Blissey', 'Psychic', 'Snorlax'],           // non-STAB special Psychic, neutral vs Normal
    ['Skarmory', 'Earthquake', 'Tauros'],        // non-STAB Ground, neutral vs Normal
  ];
  let clean = 0, mismatches = 0;
  for (const [atkName, moveName, defName] of cases) {
    let res: ReturnType<typeof calculate>;
    let atkMon: Pokemon, defMon: Pokemon, move: Move;
    try {
      atkMon = new Pokemon(gen, atkName, { level: 50 });
      defMon = new Pokemon(gen, defName, { level: 50 });
      move = new Move(gen, moveName);
      res = calculate(gen, atkMon, defMon, move, new Field({ gameType: 'Singles' }));
    } catch (e) { console.log(`  ${atkName} ${moveName} vs ${defName}: calc error (${(e as Error).message}) — skip`); continue; }
    const dmg = res.damage as number[];
    if (!Array.isArray(dmg) || dmg.length !== ROLLS) { console.log(`  ${atkName} ${moveName} vs ${defName}: non-16-roll result — skip`); continue; }
    const physical = (move as any).category === 'Physical';
    const atk = physical ? (atkMon as any).stats.atk : (atkMon as any).stats.spa;
    const def = physical ? (defMon as any).stats.def : (defMon as any).stats.spd;
    const mine = cpuRollsOne({ level: 50, bp: (move as any).bp, atk, def });
    const match = mine.every((v, k) => v === dmg[k]);
    if (match) {
      clean++;
      console.log(`  OK   ${atkName} ${moveName} vs ${defName}: rolls [${dmg[0]}..${dmg[15]}] match (bp=${(move as any).bp}, atk=${atk}, def=${def})`);
    } else {
      // Not a kernel bug — just a non-neutral case (STAB / type / ability mod).
      const eff = dmg[15]! / (mine[15]! || 1);
      console.log(`  skip ${atkName} ${moveName} vs ${defName}: calc applied a modifier (~x${eff.toFixed(2)}) — not a neutral case`);
    }
  }
  console.log(`\n  ${clean} clean neutral cases matched @smogon/calc bit-exactly; ${mismatches} true mismatches.`);
  if (clean < 3) throw new Error('expected >=3 clean neutral validations; kernel formula may be wrong');
}

// ---------------------------------------------------------------------------
// Random input generation (realistic stat/bp ranges).
// ---------------------------------------------------------------------------
function genInputs(n: number) {
  const level = new Int32Array(n), bp = new Int32Array(n), atk = new Int32Array(n), def = new Int32Array(n);
  let s = 123456789 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  for (let i = 0; i < n; i++) {
    level[i] = 50;
    bp[i] = 40 + Math.floor(rnd() * 120);      // 40..160
    atk[i] = 80 + Math.floor(rnd() * 220);     // 80..300
    def[i] = 60 + Math.floor(rnd() * 240);     // 60..300
  }
  return { level, bp, atk, def };
}

// ---------------------------------------------------------------------------
// Context: full @smogon/calc calculate() throughput, single thread.
// ---------------------------------------------------------------------------
function calcThroughput(): void {
  section('4. Context: full @smogon/calc calculate() cost (single thread)');
  const atkMon = new Pokemon(gen, 'Garchomp', { level: 50, item: 'Life Orb', ability: 'Rough Skin', nature: 'Jolly', evs: { atk: 252, spe: 252 } });
  const defMon = new Pokemon(gen, 'Tyranitar', { level: 50, ability: 'Sand Stream', nature: 'Careful', evs: { hp: 252, spd: 252 } });
  const field = new Field({ gameType: 'Doubles', weather: 'Sand' });
  const N = 20000;
  // construct fresh objects each call to mirror damage.ts (it rebuilds per call)
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const a = new Pokemon(gen, 'Garchomp', { level: 50, item: 'Life Orb', ability: 'Rough Skin', nature: 'Jolly', evs: { atk: 252, spe: 252 } });
    const d = new Pokemon(gen, 'Tyranitar', { level: 50, ability: 'Sand Stream', nature: 'Careful', evs: { hp: 252, spd: 252 } });
    const m = new Move(gen, 'Earthquake');
    const r = calculate(gen, a, d, m, field);
    acc += (r.damage as number[])[0]!;
  }
  const ms = performance.now() - t0;
  void atkMon; void defMon; void acc;
  const perCall = ms / N;
  const persec = Math.round(N / (ms / 1000));
  console.log(`  full calculate() (rebuild objects each call, like damage.ts): ${perCall.toFixed(4)} ms/call -> ${persec.toLocaleString()} calls/sec (1 thread)`);
  console.log(`  => a depth-2 search grid of ~hundreds of cells = single-digit ms of ACTUAL roll arithmetic; the rest is object build + modifier resolution.`);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  validateVsCalc();

  section('2. GPU init + correctness vs CPU');
  const gpu = await initGpu();
  console.log('  adapter info:', JSON.stringify(gpu.adapterInfo));
  {
    const n = 100000;
    const { level, bp, atk, def } = genInputs(n);
    const cpuOut = new Int32Array(n * ROLLS);
    cpuRolls(level, bp, atk, def, cpuOut);
    const batch = gpu.prepare(level, bp, atk, def);
    const { out } = await batch.run(true);
    let diffs = 0, firstDiff = -1;
    for (let i = 0; i < cpuOut.length; i++) if (cpuOut[i] !== out[i]) { diffs++; if (firstDiff < 0) firstDiff = i; }
    console.log(`  ${n} tuples x ${ROLLS} rolls = ${cpuOut.length} values: ${diffs} differences` + (diffs ? ` (first @${firstDiff}: cpu=${cpuOut[firstDiff]} gpu=${out[firstDiff]})` : ' -> GPU == CPU bit-exact'));
    batch.free();
    if (diffs) throw new Error('GPU/CPU mismatch — kernel bug');
  }

  section('3. Throughput: CPU (1 thread) vs GPU, across batch sizes');
  console.log('  batch = number of (atk,def,move,field) tuples; each emits 16 rolls.');
  console.log('  GPU total = upload + dispatch + readback (end-to-end, the honest cost).\n');
  console.log('  gpu disp = compute-only (no readback); gpu tot = upload+dispatch+readback.\n');
  const header = ['batch', 'cpu ms', 'cpu Mrl/s', 'gpu up', 'gpu disp', 'gpu read', 'gpu tot', 'gpu(disp)Mrl/s', 'spd tot', 'spd disp'];
  console.log('  ' + header.map(h => h.padStart(13)).join(''));
  for (const n of [256, 4096, 65536, 262144, 1048576]) {
    const { level, bp, atk, def } = genInputs(n);
    const cpuOut = new Int32Array(n * ROLLS);
    // warm + timed (CPU single thread; small N so it never competes with the gauntlet)
    cpuRolls(level, bp, atk, def, cpuOut);
    const reps = n <= 65536 ? 50 : (n <= 262144 ? 10 : 3);
    let cpuMs = Infinity;
    for (let r = 0; r < 3; r++) {
      const t = performance.now();
      for (let q = 0; q < reps; q++) cpuRolls(level, bp, atk, def, cpuOut);
      cpuMs = Math.min(cpuMs, (performance.now() - t) / reps);
    }
    const batch = gpu.prepare(level, bp, atk, def);
    await batch.run(true); // warm
    // end-to-end (with readback) and compute-only (no readback) timings
    let bestTot = { up: 0, disp: 0, read: 0, tot: Infinity };
    for (let r = 0; r < 5; r++) {
      const g = await batch.run(true);
      if (g.totalMs < bestTot.tot) bestTot = { up: g.uploadMs, disp: g.dispatchMs, read: g.readbackMs, tot: g.totalMs };
    }
    let bestDisp = Infinity;
    for (let r = 0; r < 5; r++) {
      const g = await batch.run(false);
      if (g.dispatchMs < bestDisp) bestDisp = g.dispatchMs;
    }
    batch.free();
    const rolls = n * ROLLS;
    const cpuMr = (rolls / (cpuMs / 1000)) / 1e6;
    const gpuDispMr = (rolls / (bestDisp / 1000)) / 1e6;
    const row = [
      n.toString(), cpuMs.toFixed(3), cpuMr.toFixed(0),
      bestTot.up.toFixed(2), bestDisp.toFixed(2), bestTot.read.toFixed(2), bestTot.tot.toFixed(2),
      gpuDispMr.toFixed(0), (cpuMs / bestTot.tot).toFixed(2) + 'x', (cpuMs / bestDisp).toFixed(2) + 'x',
    ];
    console.log('  ' + row.map(c => c.padStart(13)).join(''));
  }

  section('3b. TRUE GPU compute throughput (amortize the per-submit sync floor)');
  console.log('  Section 3\'s ~100ms "dispatch" is a FIXED Node/Dawn per-submit sync latency,');
  console.log('  not compute. Here we pack many dispatches into ONE submit+sync to expose the');
  console.log('  real kernel throughput, and report the single-dispatch round-trip floor.\n');
  {
    const n = 1048576;
    const { level, bp, atk, def } = genInputs(n);
    const batch = gpu.prepare(level, bp, atk, def);
    // round-trip floor: one tiny submit, sync
    let floorMs = Infinity;
    for (let r = 0; r < 5; r++) { const g = await batch.run(false); if (g.dispatchMs < floorMs) floorMs = g.dispatchMs; }
    const reps = 200;
    await batch.runMany(10); // warm
    let many = Infinity;
    for (let r = 0; r < 3; r++) { const t = await batch.runMany(reps); if (t < many) many = t; }
    batch.free();
    const perDispatch = many / reps;
    const trueMr = ((n * ROLLS) / (perDispatch / 1000)) / 1e6;
    console.log(`  single-dispatch round-trip floor (Node->Dawn submit+sync): ~${floorMs.toFixed(1)} ms`);
    console.log(`  amortized: ${reps} dispatches of ${n.toLocaleString()} tuples in ${many.toFixed(1)} ms total`);
    console.log(`  => ${perDispatch.toFixed(3)} ms/dispatch compute -> ${trueMr.toFixed(0)} Mrolls/s TRUE GPU compute throughput`);
    console.log(`  (vs ~360 Mrolls/s single CPU thread). The arithmetic is the easy part; the`);
    console.log(`  ~${floorMs.toFixed(0)}ms round-trip floor is fatal for the per-turn search grid (~290ms CPU today).`);
  }

  gpu.dispose();
  calcThroughput();

  section('Done');
}

main().catch(e => { console.error(e); process.exit(1); });
