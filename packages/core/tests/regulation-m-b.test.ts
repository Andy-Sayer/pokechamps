// Reg M-B switch-day readiness: the two Mega Raichu cores must light up through
// the EXISTING pipeline once the stones are legal — no new code, just data wiring
// (stone in items.allow → mega forme ability → base learnset → tactic detector).
// If a switch-day refresh-data drops a move or unpatches an ability, these fail
// loudly. See docs/notes/regulation-m-b.md.
import { describe, test, expect } from 'vitest';
import { isLegalItem, isLegalSpecies } from '../src/domain/data.js';
import { profileFromMegaStone, detectTactics } from '../src/domain/tactics.js';

describe('Reg M-B — Raichunite stones pre-staged', () => {
  test('both stones are legal items and Raichu base is legal', () => {
    expect(isLegalItem('raichunitex')).toBe(true);
    expect(isLegalItem('raichunitey')).toBe(true);
    expect(isLegalSpecies('raichu')).toBe(true);
  });
});

describe('Reg M-B — Mega Raichu Y (No Guard) nuke core', () => {
  test('the stone resolves to a No Guard mega forme profile', () => {
    const p = profileFromMegaStone('raichunitey');
    expect(p).not.toBeNull();
    expect(p!.species).toBe('Raichu-Mega-Y');
    expect(p!.abilities).toContain('noguard');
    expect(p!.item).toBe('raichunitey');
    // Inaccurate nukes No Guard turns into guaranteed hits are in the learnset.
    expect(p!.moves.has('zapcannon')).toBe(true);
    expect(p!.moves.has('focusblast')).toBe(true);
  });

  test('detectTactics surfaces a No Guard core that calls out Zap Cannon', () => {
    const hits = detectTactics([profileFromMegaStone('raichunitey')!]);
    const noGuard = hits.find(t => t.pattern === 'no-guard');
    expect(noGuard).toBeDefined();
    // Zap Cannon (120 BP / 50% acc, +100% paralysis) is the headline payoff.
    expect(noGuard!.payoff).toMatch(/Zap Cannon/i);
  });
});

describe('Reg M-B — Mega Raichu X (Electric Surge) terrain core', () => {
  test('the stone resolves to an Electric Surge mega forme profile', () => {
    const p = profileFromMegaStone('raichunitex');
    expect(p).not.toBeNull();
    expect(p!.species).toBe('Raichu-Mega-X');
    expect(p!.abilities).toContain('electricsurge');
    expect(p!.moves.has('risingvoltage')).toBe(true);
  });

  test('detectTactics surfaces a self-sufficient Electric terrain core', () => {
    const hits = detectTactics([profileFromMegaStone('raichunitex')!]);
    const terrain = hits.find(t => t.pattern === 'terrain' && /Electric/i.test(t.name));
    expect(terrain).toBeDefined();
    // Auto-terrain on entry → no setup turn needed; Rising Voltage abuses it.
    expect(terrain!.setupTurns).toBe(0);
  });
});
