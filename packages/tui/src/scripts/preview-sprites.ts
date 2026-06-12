// Sprite preview — the visual-iteration tool for Theme 6 grid sprites: fetch
// + render species sprites straight to stdout (outside Ink, like
// preview-pika.ts) so layout/scale/palette can be eyeballed and tweaked
// BEFORE judging them in the battle screen.
//
// Run: npx tsx packages/tui/src/scripts/preview-sprites.ts Garchomp Incineroar
//      npx tsx … preview-sprites.ts --scale 2 "Flutter Mane"
//      npx tsx … preview-sprites.ts --halfblock Garchomp   (universal renderer)
import { spriteFor } from '../ui/spriteCache.js';
import { composeStrip, downsampleIndexed } from '../ui/spriteStrip.js';
import { halfBlockRows } from '../ui/HalfBlockImage.js';
import { encodeSixel } from '../ui/sixel.js';

async function main() {
  const args = process.argv.slice(2);
  const scaleIdx = args.indexOf('--scale');
  const scale = scaleIdx >= 0 ? parseInt(args[scaleIdx + 1] ?? '1', 10) : 1;
  const halfblock = args.includes('--halfblock');
  const species = args.filter((a, i) => a !== '--scale' && a !== '--halfblock' && (scaleIdx < 0 || i !== scaleIdx + 1));
  if (!species.length) {
    console.error('usage: preview-sprites.ts [--scale N] [--halfblock] <species…>');
    process.exit(1);
  }
  const sprites = await Promise.all(species.map(spriteFor));
  const loaded = sprites.filter((s): s is NonNullable<typeof s> => !!s);
  console.log(`${loaded.length}/${species.length} sprites loaded (${species.join(', ')})`);
  if (!loaded.length) process.exit(1);
  const strip = composeStrip(loaded);
  if (!strip) { console.error('compose failed (palette overflow)'); process.exit(1); }
  if (halfblock) {
    // Same extra 2:1 the battle screen applies in half-block mode.
    const s = downsampleIndexed(strip, 2);
    const fg = (hex?: string) => hex ? `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m` : '';
    const bg = (hex?: string) => hex ? `\x1b[48;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m` : '';
    for (const row of halfBlockRows(s.bitmap, s.palette)) {
      process.stdout.write(row.map(seg => `${fg(seg.fg)}${bg(seg.bg)}${seg.ch}\x1b[0m`).join('') + '\n');
    }
    return;
  }
  process.stdout.write(encodeSixel(strip.bitmap, strip.palette, { scale }));
  process.stdout.write('\n');
}

main().catch(e => { console.error(e); process.exit(1); });
