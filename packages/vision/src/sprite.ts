// Sprite recognition for the OPPONENT's team — they're shown as icons with no
// text, so OCR can't help. Identify each icon by matching it against a reference
// icon per legal species. We use a perceptual hash (dHash): robust to scaling,
// compression, and the minor lighting/colour tint the game panel adds, and it's a
// cheap 64-bit Hamming compare against ~208 references (the small candidate set is
// again the accuracy win). Deterministic — no LLM/visual guessing in the loop.
//
// STATUS: the matcher (dHash + nearest-reference) is implemented + tested. What's
// stubbed is the REFERENCE TABLE — see buildSpriteRefs()'s TODO: a one-off script
// dHashes each legal species' icon (from @pkmn/img or the dex sprite sheet) into
// data/sprite-hashes.json, which loadSpriteRefs() then reads. Tune the hash size
// + add a colour-histogram tiebreak against real captured icons.

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

// TODO(reference table): generate data/sprite-hashes.json with a one-off script —
// for each id in format.champions.json legality.allow, fetch its icon (e.g.
// @pkmn/img's Icons.getPokemon(id).url, or a dex sprite sheet), decode with jimp,
// dHash it, and write { id, name, hash: hashHex }. Then loadSpriteRefs() parses
// that file. Stubbed until we wire the sprite source.
export function loadSpriteRefs(): SpriteRef[] {
  return [];   // TODO: read data/sprite-hashes.json (hash hex → bigint)
}
