// Decisive test: can @pkmn/sim actually MEGA-EVOLVE a Champions mon in a gen9
// doubles battle? The formes + stones + (now) custom abilities exist in the data,
// but gen9 removed the mega MECHANIC — so the question is whether the engine still
// performs the mega phase in customgame. If yes, the exact engine can simulate
// Champions natively (just update + patch the few missing formes).
import { ensureSimLoaded, buildBattle, readRoster } from '../domain/simBridge.js';

if (!(await ensureSimLoaded())) { console.log('sim not loaded'); process.exit(1); }

const dn = { species: 'Dragonite', item: 'Dragoninite', ability: 'Multiscale', moves: ['Dragon Claw', 'Earthquake', 'Roost', 'Protect'], nature: 'Adamant', level: 50 };
const partner = { species: 'Garchomp', item: 'Life Orb', ability: 'Rough Skin', moves: ['Earthquake', 'Dragon Claw', 'Protect', 'Stone Edge'], nature: 'Jolly', level: 50 };
const foe1 = { species: 'Talonflame', item: 'Sharp Beak', ability: 'Gale Wings', moves: ['Brave Bird', 'Flare Blitz', 'Protect', 'Tailwind'], nature: 'Jolly', level: 50 };
const foe2 = { species: 'Sableye', item: 'Leftovers', ability: 'Prankster', moves: ['Fake Out', 'Knock Off', 'Will-O-Wisp', 'Protect'], nature: 'Bold', level: 50 };

const battle = buildBattle({
  p1team: [dn, partner], p2team: [foe1, foe2],
  p1active: [0, 1], p2active: [0, 1], seed: [1, 2, 3, 4],
});

console.log('before:', readRoster(battle).p1.map(m => m.species).join(', '));
const s0 = battle.sides[0] as unknown as { choose(c: string): boolean; choice: { error?: string } };
const ok = s0.choose('move 1 1 mega, move 2 1');
console.log(`probe choose("...mega..."): ${ok}${ok ? '' : '  ERROR: ' + (s0.choice.error ?? '?')}`);
battle.makeChoices('move 1 1 mega, move 2 1', 'default');
const after = readRoster(battle).p1;
console.log('after :', after.map(m => `${m.species} (hp ${Math.round(m.hpPct)}%)`).join(', '));
const megaed = after.some(m => m.species.includes('-Mega'));
console.log(megaed ? '\n✅ MEGA EVOLUTION WORKS in @pkmn/sim gen9 customgame' : '\n❌ no mega forme appeared — mega phase not performed');
