import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize { columns: number; rows: number; }

// Live terminal dimensions, updated on SIGWINCH / stdout 'resize'. Falls back to
// 80×24 when the stream doesn't report a size (pipes, redirected output, some CI).
// Layouts read this to reflow on narrow terminals instead of overflowing.
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const read = (): TerminalSize => ({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
  const [size, setSize] = useState<TerminalSize>(read);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(read());
    stdout.on('resize', onResize);
    onResize();   // sync once on mount in case it changed before the listener attached
    return () => { stdout.off('resize', onResize); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);
  return size;
}
