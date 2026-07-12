import { describe, test, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { archiveOppSheet, loadOppSheetGroundTruth, saveOppSheetTruth, oppSheetTruthPath, OPP_SHEETS_DIR, type OppSlotRead } from '../src/oppTeamRead.js';

const slot = (n: number, name: string, source: OppSlotRead['source'] = 'sprite+type'): OppSlotRead =>
  ({ slot: n, name, score: 0.9, types: [], candidates: [], source });

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

describe('loadOppSheetGroundTruth', () => {
  test('raw read → only type-VERIFIED slots; corrected .truth.json wins and is authoritative', () => {
    const src = join(tmpdir(), `gt-src-${Date.now()}.png`);
    writeFileSync(src, 'PNGBYTES');
    // slots 1 & 6 came back as bare/unknown sprite guesses → excluded from raw ground truth
    const read = [
      slot(1, 'Mawile', 'sprite'),     // bare sprite guess — untrusted
      slot(2, 'Milotic'),
      slot(3, 'Dragonite'),
      slot(4, 'Tyranitar'),
      slot(5, 'Azumarill'),
      { slot: 6, name: '', score: 0, types: [], candidates: [], source: 'unknown' } as OppSlotRead,
    ];
    const png = archiveOppSheet(src, read)!;
    try {
      const raw = loadOppSheetGroundTruth(png)!;
      expect(raw.source).toBe('read-verified');
      expect(raw.truth).toEqual([null, 'Milotic', 'Dragonite', 'Tyranitar', 'Azumarill', null]);

      // User corrects slots 1 & 6 and confirms all six → .truth.json becomes authoritative.
      saveOppSheetTruth(png, ['Arbok', 'Milotic', 'Dragonite', 'Tyranitar', 'Azumarill', 'Gardevoir']);
      const corrected = loadOppSheetGroundTruth(png)!;
      expect(corrected.source).toBe('corrected');
      expect(corrected.truth).toEqual(['Arbok', 'Milotic', 'Dragonite', 'Tyranitar', 'Azumarill', 'Gardevoir']);
    } finally {
      rmSync(png, { force: true });
      rmSync(png.replace(/\.png$/, '.json'), { force: true });
      rmSync(oppSheetTruthPath(png), { force: true });
      rmSync(src, { force: true });
    }
  });
});
