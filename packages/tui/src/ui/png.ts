// Minimal PNG decoder for sprite ingestion (Theme 6 grid sprites). Showdown's
// gen5 sprites are small 8-bit PNGs (palette / RGB / RGBA, non-interlaced);
// node:zlib does the actual decompression so this stays dependency-free and
// bundle-friendly. Anything outside that envelope throws — callers treat a
// failed decode as "no sprite", never an error box.
import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  rgba: Uint8Array;
}

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(buf: Uint8Array): DecodedPng {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('not a PNG');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (off + 8 <= buf.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      bitDepth = buf[off + 16]!;
      colorType = buf[off + 17]!;
      interlace = buf[off + 20]!;
    } else if (type === 'PLTE') palette = data.slice();
    else if (type === 'tRNS') trns = data.slice();
    else if (type === 'IDAT') idat.push(data.slice());
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!width || !height) throw new Error('PNG: missing IHDR');
  if (interlace !== 0) throw new Error('PNG: interlaced not supported');
  if (bitDepth !== 8) throw new Error(`PNG: bit depth ${bitDepth} not supported`);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`PNG: color type ${colorType} not supported`);

  const raw = inflateSync(Buffer.concat(idat.map(d => Buffer.from(d))));
  const bpp = channels; // bytes per pixel at depth 8
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  // Un-filter scanlines (filters 0-4: None/Sub/Up/Average/Paeth).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = x >= bpp && prev ? prev[x - bpp]! : 0;
      let v = line[x]!;
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 0xff;
      } else if (filter !== 0) throw new Error(`PNG: unknown filter ${filter}`);
      cur[x] = v;
    }
  }

  // Expand to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp;
    if (colorType === 3) {
      const idx = out[s]!;
      rgba[i * 4] = palette?.[idx * 3] ?? 0;
      rgba[i * 4 + 1] = palette?.[idx * 3 + 1] ?? 0;
      rgba[i * 4 + 2] = palette?.[idx * 3 + 2] ?? 0;
      rgba[i * 4 + 3] = trns && idx < trns.length ? trns[idx]! : 255;
    } else if (colorType === 2) {
      rgba.set([out[s]!, out[s + 1]!, out[s + 2]!, 255], i * 4);
    } else if (colorType === 6) {
      rgba.set([out[s]!, out[s + 1]!, out[s + 2]!, out[s + 3]!], i * 4);
    } else if (colorType === 0) {
      rgba.set([out[s]!, out[s]!, out[s]!, 255], i * 4);
    } else { // 4: grey + alpha
      rgba.set([out[s]!, out[s]!, out[s]!, out[s + 1]!], i * 4);
    }
  }
  return { width, height, rgba };
}
