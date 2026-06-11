// Species sprite fetch + quantise for the matchup grid (Theme 6). Fetches
// Showdown's gen5 96×96 sprites on demand, decodes (png.ts), box-downsamples
// to half size, and quantises RGBA into the indexed Bitmap+Palette the sixel
// encoder consumes. Everything is best-effort: no network / unsupported PNG /
// too many colours all resolve to null and the UI simply shows no sprite.
//
// Cached in-memory per process AND on disk (data dir sprites/ sidecar,
// gitignored) so a match doesn't refetch and offline sessions keep sprites
// from earlier ones.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.js';
import type { Bitmap, Palette } from './sixel.js';
import { toId, dataDirPath, getSpecies } from '@pokechamps/core/domain/data.js';

export interface Sprite { bitmap: Bitmap; palette: Palette }

const memory = new Map<string, Sprite | null>();
const inflight = new Map<string, Promise<Sprite | null>>();

const SPRITE_URL = (id: string) => `https://play.pokemonshowdown.com/sprites/gen5/${id}.png`;

// Showdown sprite filenames keep a hyphen between base species and forme
// ('charizard-megay', 'ogerpon-wellspring') while our ids strip everything.
function spriteId(species: string): string {
  const sp = getSpecies(species) as { baseSpecies?: string; forme?: string; name?: string } | undefined;
  if (sp?.baseSpecies && sp.forme) return `${toId(sp.baseSpecies)}-${toId(sp.forme)}`;
  return toId(sp?.name ?? species);
}

function diskDir(): string {
  return join(dataDirPath(), 'sprites');
}

/** RGBA (already downsampled) → indexed bitmap + palette. Transparent pixels
 *  (alpha < 128) map to 0; the palette is built from the distinct colours,
 *  capped at 63 (sprites are flat-shaded; the cap never bites in practice). */
export function quantise(width: number, height: number, rgba: Uint8Array): Sprite | null {
  const colors: [number, number, number][] = [];
  const index = new Map<number, number>();
  const pixels = new Array<number>(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3]!;
    if (a < 128) { pixels[i] = 0; continue; }
    const key = (rgba[i * 4]! << 16) | (rgba[i * 4 + 1]! << 8) | rgba[i * 4 + 2]!;
    let idx = index.get(key);
    if (idx == null) {
      if (colors.length >= 63) return null; // not a flat sprite — bail
      colors.push([rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!]);
      idx = colors.length; // palette is 1-based (0 = transparent)
      index.set(key, idx);
    }
    pixels[i] = idx;
  }
  return { bitmap: { width, height, pixels }, palette: { colors } };
}

/** 2:1 nearest-neighbour downsample. Pixel art wants crisp edges and a
 *  PRESERVED palette — box averaging blends new colours (and blew the
 *  quantiser's cap on real sprites). Picks the first opaque pixel of each
 *  2×2 block so thin outlines survive. */
export function downsample(width: number, height: number, rgba: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const w = Math.floor(width / 2), h = Math.floor(height / 2);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      let opaque = 0;
      let pick = -1;
      for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
        const s = ((y * 2 + dy) * width + (x * 2 + dx)) * 4;
        if (rgba[s + 3]! >= 128) { opaque++; if (pick < 0) pick = s; }
      }
      if (opaque >= 2 && pick >= 0) {
        out[d] = rgba[pick]!; out[d + 1] = rgba[pick + 1]!; out[d + 2] = rgba[pick + 2]!; out[d + 3] = 255;
      } // else transparent (zeros)
    }
  }
  return { width: w, height: h, rgba: out };
}

function decodeToSprite(png: Uint8Array): Sprite | null {
  try {
    const d = decodePng(png);
    const small = downsample(d.width, d.height, d.rgba);
    return quantise(small.width, small.height, small.rgba);
  } catch {
    return null;
  }
}

/** Resolve a species' sprite: memory → disk → network. Null = unavailable. */
export async function spriteFor(species: string): Promise<Sprite | null> {
  const id = spriteId(species);
  if (memory.has(id)) return memory.get(id)!;
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = (async (): Promise<Sprite | null> => {
    const disk = join(diskDir(), `${id}.png`);
    try {
      if (existsSync(disk)) {
        const s = decodeToSprite(readFileSync(disk));
        memory.set(id, s);
        return s;
      }
    } catch { /* fall through to network */ }
    try {
      const res = await fetch(SPRITE_URL(id));
      if (!res.ok) { memory.set(id, null); return null; }
      const png = new Uint8Array(await res.arrayBuffer());
      try { mkdirSync(diskDir(), { recursive: true }); writeFileSync(disk, png); } catch { /* cache is optional */ }
      const s = decodeToSprite(png);
      memory.set(id, s);
      return s;
    } catch {
      memory.set(id, null);
      return null;
    }
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** Synchronous read of an already-resolved sprite (render path). */
export function spriteIfLoaded(species: string): Sprite | null {
  return memory.get(spriteId(species)) ?? null;
}
