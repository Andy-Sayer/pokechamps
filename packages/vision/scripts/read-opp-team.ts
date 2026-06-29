// Creator-intel increment 3 — VISION team-read: identify the opponent's six from a
// team-preview frame via colour-histogram sprite matching (the reliable team source
// vs the messy caption guess). Emits a ready-to-paste `--species` line for
// creator-intel.ts. Reuses the verified oppTeam sprite boxes + sprite-refs.json.
//   npx tsx packages/vision/scripts/read-opp-team.ts <team-preview-frame.png>
import { loadFrame } from '../src/decode.js';
import { CHAMPIONS_TEAM_PREVIEW, CHAMPIONS_OPP_PANEL_BG } from '../src/regions.js';
import { cropRegion } from '../src/visionSource.js';
import { HistogramMatcher, loadColorHistRefs } from '../src/colorHist.js';

const path = process.argv[2];
if (!path) { console.error('usage: read-opp-team.ts <team-preview-frame.png>'); process.exit(1); }

const log = (s: string) => process.stdout.write(s + '\n'); // unbuffered progress
log('loading sprite refs…');
const refs = loadColorHistRefs();
if (!refs.length) { console.error('no data/sprite-refs.json — run scripts/bootstrap-refs.ts first'); process.exit(1); }
log(`loaded ${refs.length} refs · decoding frame…`);
const frame = await loadFrame(path);
log(`decoded ${frame.width}×${frame.height} · matching 6 sprites…`);
const matcher = new HistogramMatcher(refs, { bgColor: CHAMPIONS_OPP_PANEL_BG });
// cropRegion takes a NORMALIZED rect (it applies toPixels itself) — so pass the
// oppTeam sprite rects directly, NOT opponentSpriteBoxes (which pre-pixels them).
const got = CHAMPIONS_TEAM_PREVIEW.oppTeam.map((o, i) => {
  const c = cropRegion(frame, o.sprite);
  const m = matcher.match(c.data, c.width, c.height);
  log(`  sprite ${i + 1} → ${m?.name ?? '?'} (${((m?.score ?? 0) * 100).toFixed(0)}%)`);
  return { slot: i + 1, name: m?.name ?? '?', score: m?.score ?? 0 };
});

// In-table matches score high (~0.8+); an out-of-table species falls to the
// nearest ref at ~0.5 — so gate on confidence rather than emit a wrong name.
const CONF = 0.7;
console.log(`\nread ${frame.width}×${frame.height} · ${refs.length} sprite refs · opponent team:`);
for (const g of got) console.log(`  ${g.slot}. ${g.name.padEnd(16)} (${(g.score * 100).toFixed(0)}%)${g.score < CONF ? '  ⚠ low — likely not in the ref table' : ''}`);
const confident = got.filter(g => g.name !== '?' && g.score >= CONF);
if (confident.length < 6) {
  console.log(`\n⚠ only ${confident.length}/6 confident — the sprite-ref table covers ${refs.length} species; rebuild it over all legal species (scripts/bootstrap-refs.ts) before trusting a full read.`);
}
console.log(`\n→ feed the CONFIRMED 6 to creator-intel:\n   npx tsx packages/core/src/scripts/creator-intel.ts --name <label> --species "${(confident.length === 6 ? confident : got).map(g => g.name).join(',')}"`);
