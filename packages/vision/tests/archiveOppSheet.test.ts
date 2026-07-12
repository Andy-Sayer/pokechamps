import { describe, test, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { archiveOppSheet, OPP_SHEETS_DIR, type OppSlotRead } from '../src/oppTeamRead.js';

const slot = (n: number, name: string): OppSlotRead =>
  ({ slot: n, name, score: 0.9, types: [], candidates: [], source: 'sprite+type' });

describe('archiveOppSheet', () => {
  test('durably saves a timestamped sheet + JSON sidecar, embedding the read species', () => {
    // Stand-in "frame" — archiveOppSheet just copies the file, it doesn't decode it.
    const src = join(tmpdir(), `oppsheet-src-${Date.now()}.png`);
    writeFileSync(src, 'PNGBYTES');
    const read = [slot(1, 'Tyranitar'), slot(2, 'Milotic')];

    const out = archiveOppSheet(src, read);
    try {
      expect(out).not.toBeNull();
      expect(out!.startsWith(OPP_SHEETS_DIR)).toBe(true);
      expect(out!).toMatch(/Tyranitar-Milotic\.png$/);       // species embedded in the name
      expect(existsSync(out!)).toBe(true);
      expect(readFileSync(out!, 'utf8')).toBe('PNGBYTES');    // frame copied verbatim
      const sidecar = out!.replace(/\.png$/, '.json');
      expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toHaveLength(2);
    } finally {
      if (out) { rmSync(out, { force: true }); rmSync(out.replace(/\.png$/, '.json'), { force: true }); }
      rmSync(src, { force: true });
    }
  });

  test('returns null instead of throwing when the source frame is missing', () => {
    expect(archiveOppSheet(join(tmpdir(), 'does-not-exist-xyz.png'))).toBeNull();
  });
});
