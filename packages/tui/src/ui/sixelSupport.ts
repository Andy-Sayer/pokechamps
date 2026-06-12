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

// Result of the ACTIVE terminal probe (Primary Device Attributes). Null until
// probeSixel() has run; takes precedence over the env-var heuristics below
// because it's the terminal's own answer.
let probed: boolean | null = null;

/**
 * Ask the terminal directly whether it renders sixels: write the Primary
 * Device Attributes query (CSI c) and look for capability `4` (sixel
 * graphics) in the `CSI ? …;4;… c` reply. Must run BEFORE Ink takes over
 * stdin/stdout (cli.tsx calls it at startup). Falls back silently — a
 * non-answering terminal just leaves the env heuristics in charge.
 */
export function probeSixel(timeoutMs = 200): Promise<boolean | null> {
  return new Promise(resolve => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY || !stdout.isTTY) { resolve(null); return; }
    let buf = '';
    const wasRaw = stdin.isRaw;
    const done = (answer: boolean | null) => {
      stdin.removeListener('data', onData);
      if (!wasRaw) stdin.setRawMode?.(false);
      stdin.pause();
      if (answer != null) probed = answer;
      resolve(answer);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      // Reply shape: ESC [ ? <attrs separated by ;> c
      const m = buf.match(/\x1b\[\?([\d;]*)c/);
      if (m) {
        clearTimeout(timer);
        done(m[1]!.split(';').includes('4'));
      }
    };
    try {
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on('data', onData);
      stdout.write('\x1b[c');
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

export function sixelSupported(): boolean {
  const force = process.env.POKECHAMPS_SIXEL;
  if (force === '1') return true;
  if (force === '0') return false;

  // The terminal's own answer beats every env heuristic.
  if (probed != null) return probed;

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
