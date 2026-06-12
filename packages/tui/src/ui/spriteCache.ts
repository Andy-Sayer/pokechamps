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

const memory = new Map<string, SpriteVariants | null>();
const inflight = new Map<string, Promise<SpriteVariants | null>>();

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

/** Alpha-weighted box resize to `targetH` (aspect preserved). Smooth output —
 *  callers snap colours back to the source palette so flatness survives. */
export function areaResize(width: number, height: number, rgba: Uint8Array, targetH: number): { width: number; height: number; rgba: Uint8Array } {
  const targetW = Math.max(1, Math.round(width * (targetH / height)));
  const out = new Uint8Array(targetW * targetH * 4);
  for (let y = 0; y < targetH; y++) {
    const y0 = Math.floor((y * height) / targetH), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / targetH));
    for (let x = 0; x < targetW; x++) {
      const x0 = Math.floor((x * width) / targetW), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / targetW));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * width + sx) * 4;
          const sa = rgba[s + 3]!;
          r += rgba[s]! * sa; g += rgba[s + 1]! * sa; b += rgba[s + 2]! * sa; a += sa; n++;
        }
      }
      const d = (y * targetW + x) * 4;
      if (n && a / n >= 110) { // ≥~43% coverage → opaque (solid silhouettes, no pinholes)
        out[d] = Math.round(r / a); out[d + 1] = Math.round(g / a); out[d + 2] = Math.round(b / a); out[d + 3] = 255;
      }
    }
  }
  return { width: targetW, height: targetH, rgba: out };
}

/** Snap smooth RGBA back onto an indexed palette (nearest colour) — keeps the
 *  pixel-art flatness after area-averaging. */
function snapToPalette(width: number, height: number, rgba: Uint8Array, palette: Palette): Sprite {
  const pixels = new Array<number>(width * height).fill(0);
  for (let i = 0; i < width * height; i++) {
    if (rgba[i * 4 + 3]! < 128) continue;
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!;
    let best = 1, bestD = Infinity;
    for (let c = 0; c < palette.colors.length; c++) {
      const pc = palette.colors[c]!;
      const d = (pc[0] - r) ** 2 + (pc[1] - g) ** 2 + (pc[2] - b) ** 2;
      if (d < bestD) { bestD = d; best = c + 1; }
    }
    pixels[i] = best;
  }
  return { bitmap: { width, height, pixels }, palette };
}

/** Crop RGBA to its opaque bounding box. */
function cropRgba(width: number, height: number, rgba: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3]! >= 128) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { width, height, rgba };
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    out.set(rgba.subarray(((y + minY) * width + minX) * 4, ((y + minY) * width + maxX + 1) * 4), y * w * 4);
  }
  return { width: w, height: h, rgba: out };
}

/** Both renderer variants from one decode: `sixel` at 48px (crisp pixels for
 *  real sixel terminals) and `small` for the half-block fallback. */
export interface SpriteVariants { sixel: Sprite; small: Sprite | null }

// Half-block sizing: reduce the FULL frame by an exact INTEGER factor first
// (6:1 on the 96px canvas → 16px), then crop. Integer blocks alias far less
// than crop-first arbitrary ratios (the 14px crop-first attempt was fuzzy),
// and since sprites rarely fill the canvas the cropped content lands around
// 10-13px ≈ 5-6 text rows — minimal AND clean.
const SMALL_FACTOR = 6;

function decodeToVariants(png: Uint8Array): SpriteVariants | null {
  try {
    const d = decodePng(png);
    const half = downsample(d.width, d.height, d.rgba);
    const sixel = quantise(half.width, half.height, half.rgba);
    if (!sixel) return null;
    const targetH = Math.max(8, Math.round(d.height / SMALL_FACTOR));
    const resized = areaResize(d.width, d.height, d.rgba, targetH);
    const cropped = cropRgba(resized.width, resized.height, resized.rgba);
    const small = snapToPalette(cropped.width, cropped.height, cropped.rgba, sixel.palette);
    return { sixel, small };
  } catch {
    return null;
  }
}

/** Resolve a species' sprite variants: memory → disk → network. Null = unavailable. */
export async function spriteFor(species: string): Promise<SpriteVariants | null> {
  const id = spriteId(species);
  if (memory.has(id)) return memory.get(id)!;
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = (async (): Promise<SpriteVariants | null> => {
    const disk = join(diskDir(), `${id}.png`);
    try {
      if (existsSync(disk)) {
        const s = decodeToVariants(readFileSync(disk));
        memory.set(id, s);
        return s;
      }
    } catch { /* fall through to network */ }
    try {
      const res = await fetch(SPRITE_URL(id));
      if (!res.ok) { memory.set(id, null); return null; }
      const png = new Uint8Array(await res.arrayBuffer());
      try { mkdirSync(diskDir(), { recursive: true }); writeFileSync(disk, png); } catch { /* cache is optional */ }
      const s = decodeToVariants(png);
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

/** Synchronous read of already-resolved variants (render path). */
export function spriteIfLoaded(species: string): SpriteVariants | null {
  return memory.get(spriteId(species)) ?? null;
}
