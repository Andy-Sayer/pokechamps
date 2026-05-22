// Coverage for the slash-command dispatcher. The dispatcher is a pure
// function — handlers live in the calling screen — so the tests are tiny:
// confirm the canonical verb wins, the short alias wins, unknown commands
// return null, and non-slash input returns null (so the action parser still
// gets a shot at it).
import { describe, expect, it } from 'vitest';
import {
  BATTLE_COMMANDS,
  helpLine,
  parseCommand,
  type BattleCommandId,
} from '../src/ui/slashCommands.js';

describe('parseCommand', () => {
  it('returns null for input not starting with /', () => {
    expect(parseCommand('next', BATTLE_COMMANDS)).toBeNull();
    expect(parseCommand('m1 > Close Combat > o1 > 67', BATTLE_COMMANDS)).toBeNull();
    expect(parseCommand('', BATTLE_COMMANDS)).toBeNull();
    expect(parseCommand('  ', BATTLE_COMMANDS)).toBeNull();
  });

  it('resolves canonical verbs', () => {
    expect(parseCommand('/next', BATTLE_COMMANDS)?.id).toBe('next');
    expect(parseCommand('/save', BATTLE_COMMANDS)?.id).toBe('save');
    expect(parseCommand('/info', BATTLE_COMMANDS)?.id).toBe('info');
    expect(parseCommand('/crit', BATTLE_COMMANDS)?.id).toBe('crit');
    expect(parseCommand('/allmoves', BATTLE_COMMANDS)?.id).toBe('allmoves');
    expect(parseCommand('/review', BATTLE_COMMANDS)?.id).toBe('review');
    expect(parseCommand('/quit', BATTLE_COMMANDS)?.id).toBe('quit');
    expect(parseCommand('/help', BATTLE_COMMANDS)?.id).toBe('help');
  });

  it('resolves short aliases', () => {
    expect(parseCommand('/n', BATTLE_COMMANDS)?.id).toBe('next');
    expect(parseCommand('/s', BATTLE_COMMANDS)?.id).toBe('save');
    expect(parseCommand('/i', BATTLE_COMMANDS)?.id).toBe('info');
    expect(parseCommand('/c', BATTLE_COMMANDS)?.id).toBe('crit');
    expect(parseCommand('/a', BATTLE_COMMANDS)?.id).toBe('allmoves');
    expect(parseCommand('/r', BATTLE_COMMANDS)?.id).toBe('review');
    expect(parseCommand('/q', BATTLE_COMMANDS)?.id).toBe('quit');
    expect(parseCommand('/?', BATTLE_COMMANDS)?.id).toBe('help');
  });

  it('is case-insensitive', () => {
    expect(parseCommand('/NEXT', BATTLE_COMMANDS)?.id).toBe('next');
    expect(parseCommand('/Next', BATTLE_COMMANDS)?.id).toBe('next');
  });

  it('tolerates trailing whitespace and ignores arguments after the verb', () => {
    expect(parseCommand('  /next  ', BATTLE_COMMANDS)?.id).toBe('next');
    expect(parseCommand('/info opp1', BATTLE_COMMANDS)?.id).toBe('info');
  });

  it('returns null for unknown verbs', () => {
    expect(parseCommand('/launch', BATTLE_COMMANDS)).toBeNull();
    expect(parseCommand('/', BATTLE_COMMANDS)).toBeNull();
    expect(parseCommand('/  ', BATTLE_COMMANDS)).toBeNull();
  });

  it('every command id surfaces in the registry exactly once', () => {
    const ids = BATTLE_COMMANDS.map(c => c.id);
    const dedup = new Set(ids);
    expect(dedup.size).toBe(ids.length);
    // Compile-time check: each id matches the union — TS would complain
    // if a command had an unknown id, but a runtime spot-check is cheap.
    const expected: BattleCommandId[] = ['next', 'save', 'info', 'crit', 'allmoves', 'review', 'help', 'quit'];
    for (const id of expected) expect(ids).toContain(id);
  });
});

describe('helpLine', () => {
  it('renders one /alias per command, slash-prefixed', () => {
    const line = helpLine(BATTLE_COMMANDS);
    expect(line).toContain('/next');
    expect(line).toContain('/save');
    expect(line).toContain('/allmoves');
    // Format: " · " separator between entries.
    expect(line).toMatch(/^\/\w+( · \/\w+)+$/);
  });
});
