// Runtime sixel-support probe. Used by the PikaSpinner to pick between the
// bitmap renderer (real pixels via sixel escape sequences) and the legacy
// half-block character renderer.
//
// We can't reliably feature-detect sixel in a way that's compatible with
// Ink's renderer (which owns stdin/stdout). Instead we use a deny/allow
// list keyed off env vars that terminal emulators stamp themselves:
//
//   POKECHAMPS_SIXEL=1   force on
//   POKECHAMPS_SIXEL=0   force off
//   TERM_PROGRAM         iTerm/WezTerm/etc. brand
//   WT_SESSION           set by Windows Terminal (Preview ≥1.22 supports sixel)
//   TERM                 contains 'mlterm', 'foot', 'kitty', etc.
//
// Conservative default: ON only when we recognise a sixel-supporting terminal.
// Fall back to half-block in unknown environments.

export function sixelSupported(): boolean {
  const force = process.env.POKECHAMPS_SIXEL;
  if (force === '1') return true;
  if (force === '0') return false;

  const term = (process.env.TERM ?? '').toLowerCase();
  const termProgram = (process.env.TERM_PROGRAM ?? '').toLowerCase();

  // Known sixel-capable terminals.
  if (process.env.WT_SESSION) return true;            // Windows Terminal
  if (termProgram === 'wezterm') return true;
  if (termProgram === 'iterm.app') return true;       // iTerm2 (sixel opt-in)
  if (termProgram === 'tabby') return true;
  if (term.includes('mlterm')) return true;
  if (term.includes('foot')) return true;
  if (term.includes('kitty')) return true;            // via xterm-kitty compat

  // Last-resort heuristic: Windows-side runners (git-bash, ConEmu, etc.)
  // launched inside Windows Terminal sometimes strip WT_SESSION but leave
  // WT_PROFILE_ID intact. Check for that as a fallback.
  if (process.env.WT_PROFILE_ID) return true;

  return false;
}
