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
  | 'edit'
  | 'save'
  | 'info'
  | 'crit'
  | 'allmoves'
  | 'why'
  | 'grid'
  | 'review'
  | 'pika'
  | 'sprites'
  | 'export'
  | 'ask'
  | 'endgame'
  | 'exact'
  | 'override'
  | 'share'
  | 'summary'
  | 'vision'
  | 'feed'
  | 'watch'
  | 'help'
  | 'quit';

export interface BattleCommand {
  id: BattleCommandId;
  aliases: readonly string[];
  description: string;
}

export const BATTLE_COMMANDS: readonly BattleCommand[] = [
  { id: 'next',     aliases: ['next', 'n'],           description: 'Finalize the in-progress turn' },
  { id: 'undo',     aliases: ['undo', 'u'],           description: 'Remove a turn event (move or boost): /undo (last) or /undo N (the Nth)' },
  { id: 'edit',     aliases: ['edit', 'e'],           description: 'Edit turn event N (move or boost): /edit N pulls its line back into the input' },
  { id: 'save',     aliases: ['save', 's', 'snap'],   description: 'Snapshot the match to disk / server' },
  { id: 'info',     aliases: ['info', 'i'],           description: 'Open the opponent info picker' },
  { id: 'crit',     aliases: ['crit', 'c'],           description: 'Toggle crit damage column in matchup grid' },
  { id: 'allmoves', aliases: ['allmoves', 'all', 'a'], description: 'Toggle all-my-moves view per opp' },
  { id: 'why',      aliases: ['why', 'd'],            description: 'Toggle the best-play box detail (watch/why/oppLine/1D-chess/approximating); off = just the play + risks' },
  { id: 'grid',     aliases: ['grid', 'g'],           description: 'Toggle the full 6-opponent matchup grid; off = just the live/brought board' },
  { id: 'review',   aliases: ['review', 'r'],         description: 'Ask Pikachu (Claude) to review the last turn' },
  { id: 'pika',     aliases: ['pika', 'p'],           description: 'Toggle a Pikachu sprite (for sixel preview)' },
  { id: 'sprites',  aliases: ['sprites', 'spr'],      description: 'Toggle sprites of the active opponents above the matchup grid (sixel, or half-block on any terminal; sticky)' },
  { id: 'export',   aliases: ['export', 'x'],         description: 'Show the current team as a Showdown export' },
  { id: 'ask',      aliases: ['ask'],                 description: 'Predict a hypothetical matchup: /ask m1 vs o3  or  /ask Delphox-Mega vs Sneasler' },
  { id: 'endgame',  aliases: ['endgame', 'eg'],       description: 'Best-play recommendation for the current actives (1-ply endgame solver)' },
  { id: 'exact',    aliases: ['exact', 'sim'],        description: 'Resolve the recommended line through the REAL Showdown engine (@pkmn/sim) — ground-truth outcome over 16 RNG seeds' },
  { id: 'override', aliases: ['override', 'ov'],      description: 'Open the manual state editor (field / HP / status / boosts / positions)' },
  { id: 'share',    aliases: ['share', 'sh'],         description: 'Live-share this match (remote mode): /share for a spectator link, /share off to revoke' },
  { id: 'summary',  aliases: ['summary', 'sum'],      description: 'Match summary: per-mon damage dealt / taken, KOs, turn count' },
  { id: 'vision',   aliases: ['vision', 'vis'],       description: 'Ratify vision-built turn-log lines (semicolon-separated): /vision m1 > Close Combat > o1 > 33; o1 ko — opens the proposal panel. HDMI capture feeds these automatically once wired.' },
  { id: 'feed',     aliases: ['feed'],                description: 'How to watch the live HDMI capture (separate process): run "npm run -w @pokechamps/vision serve" in a terminal, then open http://localhost:8099' },
  { id: 'watch',    aliases: ['watch'],               description: 'Auto-read the live feed into ratify proposals. Ctrl+R = start/stop (full frame). /watch = GameShare inset, /watch full = full frame, again to stop. Run "serve" first.' },
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
