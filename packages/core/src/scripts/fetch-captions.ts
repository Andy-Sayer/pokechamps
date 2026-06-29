// Increment 1 — fetch a YouTube video's auto-captions (no audio/LLM) via yt-dlp,
// the input to creator-intel.ts. Writes a .vtt next to the chosen output name.
// Needs yt-dlp on PATH or `python -m yt_dlp` (install: pip install yt-dlp).
//   npx tsx packages/core/src/scripts/fetch-captions.ts <youtube-url> [outBaseName]
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';

const url = process.argv[2];
const base = process.argv[3] ?? 'captions';
if (!url) { console.error('usage: fetch-captions.ts <youtube-url> [outBaseName]'); process.exit(1); }

// Locate yt-dlp: PATH binary, else the pip module via python (mirrors youtube.ts).
function ytdlp(): { cmd: string; pre: string[] } | null {
  if (spawnSync('yt-dlp', ['--version'], { stdio: 'ignore' }).status === 0) return { cmd: 'yt-dlp', pre: [] };
  for (const py of ['python', 'python3', 'py']) {
    if (spawnSync(py, ['-m', 'yt_dlp', '--version'], { stdio: 'ignore' }).status === 0) return { cmd: py, pre: ['-m', 'yt_dlp'] };
  }
  return null;
}
const yt = ytdlp();
if (!yt) { console.error('yt-dlp not found. Install it:  pip install yt-dlp   (or put yt-dlp on PATH)'); process.exit(1); }

const outDir = join(dataDirPath(), 'captions'); mkdirSync(outDir, { recursive: true });
const out = join(outDir, base);
// Auto-subtitles only, English, no video download → a .vtt at <out>.<lang>.vtt.
const args = ['--write-auto-sub', '--sub-lang', 'en.*', '--sub-format', 'vtt', '--skip-download', '--convert-subs', 'vtt', '-o', out, url];
console.log(`[fetch-captions] ${yt.cmd} ${[...yt.pre, ...args].join(' ')}`);
const r = spawnSync(yt.cmd, [...yt.pre, ...args], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[fetch-captions] yt-dlp failed (no captions, or network/login required)'); process.exit(1); }
console.log(`\n[fetch-captions] captions written under ${outDir}/ (look for ${base}*.vtt)`);
console.log(`next: npx tsx packages/core/src/scripts/creator-intel.ts --name <label> --vtt ${outDir}/${base}.en.vtt`);
