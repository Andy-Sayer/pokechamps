// Sprite recognition for the OPPONENT's team — they're shown as icons with no
// text, so OCR can't help. Identify each icon by matching it against a reference
// icon per legal species. We use a perceptual hash (dHash): robust to scaling,
// compression, and the minor lighting/colour tint the game panel adds, and it's a
// cheap 64-bit Hamming compare against ~208 references (the small candidate set is
// again the accuracy win). Deterministic — no LLM/visual guessing in the loop.
//
// STATUS: the matcher (dHash + nearest-reference) is implemented + tested on
// identical-art inputs (same image → distance 0). But matching ACROSS ART STYLES
// does NOT work, and this was measured, not assumed: dHashing the game's official-
// render sprites against public sources (@pkmn/img Showdown icons; PokeAPI HOME
// renders) gives noise-level distances — captured sprite vs its OWN correct icon
// landed 27–35/64 (farther than random other icons), and even two clean sources of
// the SAME species (Showdown icon vs HOME render) sit 18–44/64 apart (2026-06).
// Global-luminance dHash cannot bridge pixel-art vs 3D-render. Public icons are a
// proven dead end as a reference source.
//
// FURTHER: even GAME-ART-vs-GAME-ART, dHash is too alignment-fragile for species ID
// — a ±6px shift on a 126px preview sprite flipped up to 22/64 bits, as large as the
// gap between different species (5/54 jittered crops misidentified). The VALIDATED
// matcher is a background-masked COLOUR HISTOGRAM — see colorHist.ts (54/54 correct
// under ±8px jitter, 6/6 cross-frame; species separation 0.76 vs self-dist 0.49).
// dHash below is retained for true near-duplicate checks (same render, recompressed),
// NOT species identification; loadSpriteRefs() stays stubbed in favour of
// loadColorHistRefs() / data/sprite-refs.json.

/** Average luminance downscale of an RGBA buffer to outW×outH (box filter). */
function downscaleGrey(pixels: Uint8ClampedArray | number[], width: number, height: number, outW: number, outH: number): number[] {
  const out = new Array<number>(outW * outH).fill(0);
  for (let ty = 0; ty < outH; ty++) {
    const y0 = Math.floor((ty * height) / outH), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / outH));
    for (let tx = 0; tx < outW; tx++) {
      const x0 = Math.floor((tx * width) / outW), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / outW));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        sum += 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!;
        n++;
      }
      out[ty * outW + tx] = n ? sum / n : 0;
    }
  }
  return out;
}

/** Difference hash: downscale to (size+1)×size greyscale, then 1 bit per cell =
 *  "brighter than its right neighbour". size=8 → a 64-bit hash as a bigint. */
export function dHash(pixels: Uint8ClampedArray | number[], width: number, height: number, size = 8): bigint {
  const g = downscaleGrey(pixels, width, height, size + 1, size);
  let hash = 0n, bit = 0n;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (g[y * (size + 1) + x]! > g[y * (size + 1) + x + 1]!) hash |= 1n << bit;
      bit++;
    }
  }
  return hash;
}

/** Hamming distance between two hashes (number of differing bits). */
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b, c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

export interface SpriteRef { id: string; name: string; hash: bigint; }
export interface SpriteMatch { id: string; name: string; distance: number; score: number; }

/** Nearest-reference sprite matcher over a set of precomputed dHashes. */
export class SpriteHashMatcher {
  constructor(private readonly refs: readonly SpriteRef[], private readonly size = 8) {}
  /** Best legal-species match for a cropped sprite (RGBA). score = 1 − dist/bits. */
  match(pixels: Uint8ClampedArray | number[], width: number, height: number): SpriteMatch | null {
    if (!this.refs.length) return null;
    const h = dHash(pixels, width, height, this.size);
    const bits = this.size * this.size;
    let best: SpriteRef | null = null, bestD = Infinity;
    for (const r of this.refs) { const d = hamming(h, r.hash); if (d < bestD) { bestD = d; best = r; } }
    return best ? { id: best.id, name: best.name, distance: bestD, score: 1 - bestD / bits } : null;
  }
}

// TODO(reference table): build data/sprite-hashes.json from the GAME'S OWN sprites,
// NOT public icons (proven not to match cross-art — see STATUS above). Capture each
// legal species' Champions sprite once (team-builder screen, or harvested live),
// crop, dHash, write { id, name, hash: hashHex }. Then loadSpriteRefs() parses that
// file. Stubbed until we have game-art reference crops.
export function loadSpriteRefs(): SpriteRef[] {
  return [];   // TODO: read data/sprite-hashes.json (hash hex → bigint)
}
