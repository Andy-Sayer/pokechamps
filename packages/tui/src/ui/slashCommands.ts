// Slash-command dispatcher for the battle screen + bring picker.
//
// Why this exists: BattleScreen used to listen for raw letter keys (n/s/i/c/
// a/r) via Ink's useInput, but those collide with the text input box — typing
// "Astral Barrage" would trigger the 'a' (all-moves) toggle mid-line. The
// fix is to require a leading '/' so the input is unambiguous: anything that
// doesn't start with '/' is parsed as an action line; '/something' is a
// command.
//
// Commands are case-insensitive. Short aliases are intentionally one or two
// letters so muscle memory from the old single-letter hotkeys still works.
//
// The dispatcher itself is pure data — handlers live in the calling screen.
// This keeps screens responsible for their own state but gives us a single
// place to declare command names + help text + alias resolution.

export type BattleCommandId =
  | 'next'
  | 'undo'
  | 'save'
  | 'info'
  | 'crit'
  | 'allmoves'
  | 'review'
  | 'pika'
  | 'export'
  | 'ask'
  | 'help'
  | 'quit';

export interface BattleCommand {
  id: BattleCommandId;
  aliases: readonly string[];
  description: string;
}

export const BATTLE_COMMANDS: readonly BattleCommand[] = [
  { id: 'next',     aliases: ['next', 'n'],           description: 'Finalize the in-progress turn' },
  { id: 'undo',     aliases: ['undo', 'u'],           description: 'Remove the last drafted action from this turn' },
  { id: 'save',     aliases: ['save', 's', 'snap'],   description: 'Snapshot the match to disk / server' },
  { id: 'info',     aliases: ['info', 'i'],           description: 'Open the opponent info picker' },
  { id: 'crit',     aliases: ['crit', 'c'],           description: 'Toggle crit damage column in matchup grid' },
  { id: 'allmoves', aliases: ['allmoves', 'all', 'a'], description: 'Toggle all-my-moves view per opp' },
  { id: 'review',   aliases: ['review', 'r'],         description: 'Ask Pikachu (Claude) to review the last turn' },
  { id: 'pika',     aliases: ['pika', 'p'],           description: 'Toggle a Pikachu sprite (for sixel preview)' },
  { id: 'export',   aliases: ['export', 'x'],         description: 'Show the current team as a Showdown export' },
  { id: 'ask',      aliases: ['ask'],                 description: 'Predict a hypothetical matchup: /ask m1 vs o3  or  /ask Delphox-Mega vs Sneasler' },
  { id: 'help',     aliases: ['help', 'h', '?'],      description: 'Show available commands' },
  { id: 'quit',     aliases: ['quit', 'q', 'end'],    description: 'End the match and return to the menu' },
];

export interface ParsedCommand<T extends string> {
  id: T;
  raw: string;
  /** Everything after the verb token, untrimmed-internally but with leading/
   *  trailing whitespace stripped. Empty string when the user provided no
   *  arguments. Most commands ignore this; /ask uses it. */
  args: string;
}

// Returns the canonical command id for an input string, or null if the input
// doesn't start with '/' OR doesn't match any registered command. Trailing
// whitespace is tolerated; the part after the verb is exposed as `args`.
export function parseCommand<T extends string>(
  input: string,
  commands: readonly { id: T; aliases: readonly string[] }[],
): ParsedCommand<T> | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  // Take just the first whitespace-delimited token after the slash.
  const rest = trimmed.slice(1);
  const m = rest.match(/^(\S+)(?:\s+(.*))?$/);
  if (!m) return null;
  const verb = m[1]!.toLowerCase();
  const args = (m[2] ?? '').trim();
  if (!verb) return null;
  for (const cmd of commands) {
    if (cmd.aliases.includes(verb)) return { id: cmd.id, raw: trimmed, args };
  }
  return null;
}

// Build the help footer string the battle screen + bring picker render below
// the input box. One-line summary of each command in canonical form.
export function helpLine(commands: readonly { id: string; aliases: readonly string[]; description: string }[]): string {
  return commands
    .map(c => `/${c.aliases[0]}`)
    .join(' · ');
}
