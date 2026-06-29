// Does @pkmn/sim 0.10.11 assign the CORRECT Champions ability to every custom
// mega forme at RUNTIME? If all match our verified MEGA_ABILITY_OVERRIDES, no
// local overlay is needed — the exact engine is fully Champions-ready.
import { ensureSimLoaded, buildBattle } from '../domain/simBridge.js';
if (!(await ensureSimLoaded())) { console.log('sim not loaded'); process.exit(1); }

// From gimmicks/mega.ts MEGA_ABILITY_OVERRIDES (our web-verified Champions truth).
const expected: Record<string, string> = {
  'Pyroar-Mega': 'Fire Mane', 'Eelektross-Mega': 'Eelevate', 'Staraptor-Mega': 'Contrary',
  'Scolipede-Mega': 'Shell Armor', 'Scrafty-Mega': 'Intimidate', 'Malamar-Mega': 'Contrary',
  'Barbaracle-Mega': 'Tough Claws', 'Dragalge-Mega': 'Regenerator', 'Falinks-Mega': 'Defiant',
};
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const battle = buildBattle({
  p1team: [{ species: 'Garchomp', moves: ['Earthquake'], level: 50 }, { species: 'Dragonite', moves: ['Outrage'], level: 50 }],
  p2team: [{ species: 'Talonflame', moves: ['Brave Bird'], level: 50 }, { species: 'Sableye', moves: ['Knock Off'], level: 50 }],
  p1active: [0, 1], p2active: [0, 1],
});
const dx = (battle as unknown as { dex: { species: { get(n: string): { abilities?: Record<string, string>; exists?: boolean } } } }).dex;

let mismatches = 0;
for (const [forme, want] of Object.entries(expected)) {
  const sp = dx.species.get(forme);
  const got = sp?.abilities?.['0'] ?? '(forme absent)';
  const ok = norm(got) === norm(want);
  if (!ok) mismatches++;
  console.log(`${forme.padEnd(18)} sim="${got}"`.padEnd(46) + `want="${want}"  ${ok ? 'OK' : '❌ MISMATCH'}`);
}
console.log(`\n${mismatches === 0 ? '✅ ALL custom-forme abilities correct in 0.10.11 — NO overlay needed' : `⚠️ ${mismatches} forme(s) need an overlay`}`);
