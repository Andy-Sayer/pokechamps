// Human review sheet for sprite-ref ALLOCATIONS (crop -> species). Colour-hist matching
// and my visual IDs both make mistakes (a shiny Grimmsnarl once got labelled "Mewtwo"),
// so no ref should be trusted until a human confirms the crop actually IS that species.
// This emits a self-contained HTML contact sheet: each ref's source crop + assigned
// species + its NEAREST RIVAL species (small rival-distance = ambiguous = review first)
// + verified badge. Riskiest / unverified cards sort to the top.
//   npx tsx packages/vision/scripts/review-sheet.ts [out.html]
// Then: confirm/reject each; tell me the wrong ones and I'll relabel + mark verified.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '@pokechamps/core/domain/data.js';
import { histDistance } from '../src/colorHist.js';

type Ref = { id: string; name: string; hist: number[]; verified?: boolean };
const refs = (JSON.parse(readFileSync(join(dataDirPath(), 'sprite-refs.json'), 'utf8')).refs as Ref[]);
const cropDir = join(dataDirPath(), 'sprite-ref-crops');

const rows = refs.map((r) => {
  // nearest ref of a DIFFERENT species (variants of the same species don't count as rivals)
  let rival = '—', rd = Infinity;
  for (const s of refs) {
    if (toId(s.name) === toId(r.name)) continue;
    const d = histDistance(r.hist, s.hist);
    if (d < rd) { rd = d; rival = s.name; }
  }
  const cropPath = join(cropDir, `${r.id}.png`);
  const crop = existsSync(cropPath) ? `data:image/png;base64,${readFileSync(cropPath).toString('base64')}` : null;
  return { id: r.id, name: r.name, verified: !!r.verified, rival, rd, crop };
});
// sort: unverified first, then no-crop, then riskiest (smallest rival distance) first
rows.sort((a, b) =>
  Number(a.verified) - Number(b.verified) ||
  Number(!!a.crop) - Number(!!b.crop) ||
  a.rd - b.rd);

const nVer = rows.filter((r) => r.verified).length;
const nCrop = rows.filter((r) => r.crop).length;
const cell = (r: typeof rows[number]) => {
  const risk = r.rd < 0.5 ? 'risk' : r.rd < 0.75 ? 'warn' : '';
  const img = r.crop
    ? `<img src="${r.crop}" alt="${r.name}">`
    : `<div class="nocrop">no source crop<br>(legacy — re-capture)</div>`;
  return `<figure class="${risk} ${r.verified ? 'ok' : 'unv'}">
    ${img}
    <figcaption><b>${r.name}</b>${r.id !== toId(r.name) ? ` <span class="var">${r.id}</span>` : ''}
    <span class="badge">${r.verified ? '✓ verified' : '● unverified'}</span>
    <span class="rival">nearest other: ${r.rival} (${r.rd === Infinity ? '—' : r.rd.toFixed(2)})</span>
    </figcaption></figure>`;
};

const html = `<title>Sprite-ref allocation review</title>
<style>
  :root{color-scheme:light dark}
  body{font:14px/1.4 system-ui,sans-serif;margin:0;padding:16px;background:#111;color:#eee}
  h1{font-size:18px;margin:0 0 4px} .sub{opacity:.7;margin:0 0 16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
  figure{margin:0;background:#1c1c1e;border:2px solid #333;border-radius:8px;padding:8px;text-align:center}
  figure.unv{border-color:#c93} figure.ok{border-color:#2a2}
  figure.warn{background:#2a2410} figure.risk{background:#2e1414;border-color:#e44}
  img{width:100%;max-width:120px;height:120px;object-fit:contain;background:#7a0b39;border-radius:4px;image-rendering:pixelated}
  .nocrop{width:100%;height:120px;display:flex;align-items:center;justify-content:center;background:#222;color:#888;border-radius:4px;font-size:11px}
  figcaption{margin-top:6px;font-size:12px} .var{color:#e8a;font-size:10px}
  .badge{display:block;font-size:10px;margin-top:2px} .ok .badge{color:#5d5} .unv .badge{color:#eb5}
  .rival{display:block;font-size:10px;opacity:.65;margin-top:2px}
  .risk .rival{color:#f88;opacity:1}
</style>
<h1>Sprite-ref allocation review — ${refs.length} refs</h1>
<p class="sub">${nVer} verified · ${refs.length - nVer} unverified · ${nCrop} with source crop · ${refs.length - nCrop} legacy (no crop). Red = a rival species is dangerously close (review first). Confirm each crop really IS the labelled species; flag the wrong ones.</p>
<div class="grid">${rows.map(cell).join('')}</div>`;

const outPath = process.argv[2] ?? join(process.cwd(), 'sprite-ref-review.html');
(await import('node:fs')).writeFileSync(outPath, html);
console.log(`wrote ${outPath} (${refs.length} refs, ${nCrop} with crops, ${nVer} verified)`);
