// Integration tests for POST /matches/:id/turns and POST /matches/:id/state.
// These exercise the full pipeline end-to-end: HTTP → engine → sqlite → HTTP.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, disposeApp, freshApp, registerUser } from './helpers.js';

process.env.DATABASE_URL = 'file::memory:';
process.env.JWT_SECRET = 'test-secret-not-for-production-use-only-tests';
process.env.NODE_ENV = 'test';

let app: FastifyInstance;

beforeEach(async () => {
  app = await freshApp();
});

afterEach(async () => {
  await disposeApp(app);
});

// A small seed match: 4-mon team, 2 opp leads, no turns yet.
function buildSeedMatch(): Record<string, unknown> {
  return {
    startedAt: '2026-05-20T12:00:00.000Z',
    myTeam: [
      {
        species: 'Sneasler', level: 50, ability: 'Unburden', nature: 'Jolly',
        evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        moves: ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect'],
      },
      {
        species: 'Rillaboom', level: 50, ability: 'Grassy Surge', nature: 'Adamant',
        evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 },
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        moves: ['Grassy Glide', 'Wood Hammer', 'U-turn', 'Fake Out'],
      },
      {
        species: 'Iron Hands', level: 50, ability: 'Quark Drive', nature: 'Adamant',
        evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 },
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        moves: ['Drain Punch', 'Wild Charge', 'Fake Out', 'Protect'],
      },
      {
        species: 'Flutter Mane', level: 50, ability: 'Protosynthesis', nature: 'Timid',
        evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        moves: ['Moonblast', 'Shadow Ball', 'Dazzling Gleam', 'Protect'],
      },
    ],
    opponentTeam: [
      { species: 'Incineroar', knownMoves: [] },
      { species: 'Amoonguss', knownMoves: [] },
      { species: 'Garchomp', knownMoves: [] },
      { species: 'Talonflame', knownMoves: [] },
    ],
    bring: [0, 1, 2, 3],
    opponentBrought: [0, 1],
    turns: [],
    field: {
      weather: null, terrain: null, trickRoom: false,
      myTailwind: false, theirTailwind: false,
      myReflect: false, myLightScreen: false,
      theirReflect: false, theirLightScreen: false,
    },
    active: { mine: [null, null], theirs: [null, null] },
  };
}

async function createMatch(token: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/matches',
    headers: authHeaders(token),
    payload: { match: { ...buildSeedMatch(), ...overrides } },
  });
  if (res.statusCode !== 200) throw new Error(`createMatch: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

describe('match-actions: POST /matches/:id/turns', () => {
  it('damage action updates opp HP and persists', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    // Sneasler Close Combat → Incineroar. Both Sneasler (the active attacker
    // = bring[0]) and Incineroar (the active defender = opponentBrought[0])
    // are in our top-10 Pikalytics cache, so inference fires the prior path
    // and stays fast. Targeting an off-meta species here would force the
    // engine into the exhaustive coarse grid (9^3 × natures × items × abilities
    // = ~360k spreads × @smogon/calc per spread; tens of seconds — a known
    // perf gap to fix server-side later, see PHASE_2_4_NOTES.md).
    const action = {
      side: 'mine',
      attackerSlot: 0,
      attackerTeamIndex: 0,
      kind: 'move',
      move: 'Close Combat',
      target: { side: 'theirs', slot: 0 },
      targetTeamIndex: 0,
      targetRemainingHpPercent: 35,
      order: 1,
    };
    const res = await app.inject({
      method: 'POST', url: `/matches/${id}/turns`,
      headers: authHeaders(token),
      payload: { actions: [action], field: buildSeedMatch().field },
    });
    expect(res.statusCode).toBe(200);
    const match = res.json() as any;
    expect(match.opponentTeam[0].currentHpPercent).toBe(35);
    expect(match.turns).toHaveLength(1);
    // Inference candidates field populated (may be 0 or more entries).
    expect(Array.isArray(match.opponentTeam[0].candidates)).toBe(true);

    // GET back persists same state.
    const get = await app.inject({
      method: 'GET', url: `/matches/${id}`, headers: authHeaders(token),
    });
    expect((get.json() as any).opponentTeam[0].currentHpPercent).toBe(35);
  }, 15_000);

  it('switch action updates opp brought list and active slot', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    const switchAction = {
      side: 'theirs',
      attackerSlot: 0,
      kind: 'switch',
      move: 'Garchomp',
      target: 'self',
      targetTeamIndex: 2,
      order: 1,
    };
    const res = await app.inject({
      method: 'POST', url: `/matches/${id}/turns`,
      headers: authHeaders(token),
      payload: { actions: [switchAction], field: buildSeedMatch().field },
    });
    expect(res.statusCode).toBe(200);
    const match = res.json() as any;
    expect(match.opponentBrought).toEqual([0, 1, 2]);
  });

  it('404 when match id does not exist', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const res = await app.inject({
      method: 'POST', url: `/matches/00000000-0000-0000-0000-000000000000/turns`,
      headers: authHeaders(token),
      payload: { actions: [], field: buildSeedMatch().field },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404 when match belongs to another user', async () => {
    const alice = await registerUser(app, 'alice@test.example');
    const bob = await registerUser(app, 'bob@test.example');
    const id = await createMatch(alice.token);

    const res = await app.inject({
      method: 'POST', url: `/matches/${id}/turns`,
      headers: authHeaders(bob.token),
      payload: { actions: [], field: buildSeedMatch().field },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 when body fails top-level shape check', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);
    const res = await app.inject({
      method: 'POST', url: `/matches/${id}/turns`,
      headers: authHeaders(token),
      payload: { not: 'a turn' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('413 on a body that exceeds the 256KB cap', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);
    // 300KB payload via a single huge note field.
    const huge = 'x'.repeat(300 * 1024);
    const res = await app.inject({
      method: 'POST', url: `/matches/${id}/turns`,
      headers: authHeaders(token),
      payload: { actions: [{ notes: huge }], field: buildSeedMatch().field },
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('match-actions: POST /matches/:id/state', () => {
  it('hp set on opp via state update', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    const res = await app.inject({
      method: 'POST', url: `/matches/${id}/state`,
      headers: authHeaders(token),
      payload: { update: { side: 'theirs', teamIndex: 0, hpPercent: 42 } },
    });
    expect(res.statusCode).toBe(200);
    const match = res.json() as any;
    expect(match.opponentTeam[0].currentHpPercent).toBe(42);
  });

  it('hazard update toggles theirHazards.rocks', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    const res = await app.inject({
      method: 'POST', url: `/matches/${id}/state`,
      headers: authHeaders(token),
      payload: { update: { side: 'theirs', verb: 'rocks', arg: 'on' } },
    });
    expect(res.statusCode).toBe(200);
    const match = res.json() as any;
    expect(match.field.theirHazards.rocks).toBe(true);
  });

  it('fainted on last brought opp flips outcome to victory', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    // Seed with all 4 opps pre-marked brought + 3 already fainted.
    const seed = buildSeedMatch();
    seed.opponentBrought = [0, 1, 2, 3];
    (seed.opponentTeam as any[]).forEach((o, i) => {
      if (i < 3) { o.fainted = true; o.currentHpPercent = 0; }
    });
    const id = await createMatch(token, seed);

    const res = await app.inject({
      method: 'POST', url: `/matches/${id}/state`,
      headers: authHeaders(token),
      payload: { update: { side: 'theirs', teamIndex: 3, fainted: true } },
    });
    expect(res.statusCode).toBe(200);
    const match = res.json() as any;
    expect(match.outcome).toBe('victory');

    // Outcome is also reflected in the denormalized column.
    const list = await app.inject({
      method: 'GET', url: '/matches', headers: authHeaders(token),
    });
    const summary = (list.json() as any[]).find(m => m.id === id);
    expect(summary.outcome).toBe('victory');
  });
});
