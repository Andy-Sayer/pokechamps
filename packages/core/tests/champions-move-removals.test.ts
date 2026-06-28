// Champions per-species move removals (Reg M-B): @pkmn/dex doesn't carry the
// Champions-specific learnset cuts, so getLearnset strips them from
// format.moves.removeBySpecies. Removed moves must vanish from a mon's pool
// while its other moves — and the same move on OTHER mons — stay legal.
import { describe, test, expect } from 'vitest';
import { getLearnset } from '../src/domain/data.js';

describe('Champions per-species move removals', () => {
  test('Metagross loses Heavy Slam + Knock Off but keeps its real moves', () => {
    const ls = getLearnset('Metagross');
    expect(ls).not.toContain('Heavy Slam');
    expect(ls).not.toContain('Knock Off');
    expect(ls).toContain('Meteor Mash'); // STAB retained
    expect(ls).toContain('Bullet Punch'); // priority retained
  });

  test('the other M-B cuts apply', () => {
    expect(getLearnset('Annihilape')).not.toContain('Final Gambit');
    expect(getLearnset('Grimmsnarl')).not.toContain('Thunder Wave');
    expect(getLearnset('Grimmsnarl')).not.toContain('False Surrender');
    expect(getLearnset('Scrafty')).not.toContain('Parting Shot');
    expect(getLearnset('Overqwil')).not.toContain('Mortal Spin');
    expect(getLearnset('Gholdengo')).not.toContain('Thunder Wave');
    expect(getLearnset('Pyroar')).not.toContain('Earth Power');
  });

  test('removals are per-species — Knock Off stays legal on a mon that keeps it', () => {
    // Incineroar legally learns Knock Off and is NOT on the removal list, so the
    // per-species cut (which strips it from Metagross) must not touch it —
    // guards against a global strip.
    const inc = getLearnset('Incineroar');
    expect(inc.length).toBeGreaterThan(0);
    expect(inc).toContain('Knock Off');
  });
});
