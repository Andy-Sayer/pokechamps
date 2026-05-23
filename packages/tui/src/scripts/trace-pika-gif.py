# Re-trace the Running-Pikachu GIF into pikaSprite.ts. Auto-detects the
# intrinsic pixel scale by measuring the shortest non-background horizontal
# run length, then downsamples by that factor. Crops each frame to a shared
# bounding box so the animation doesn't shift between frames.
#
# Usage:
#   curl -sL <gif-url> -o /tmp/pika.gif
#   PYTHONIOENCODING=utf-8 python packages/tui/src/scripts/trace-pika-gif.py /tmp/pika.gif > packages/tui/src/ui/pikaSprite.ts
#
# Requires Pillow:  python -m pip install Pillow
import sys
from collections import Counter
from PIL import Image

if len(sys.argv) < 2:
    print("usage: trace-pika-gif.py <path-to-gif> [frames=N]", file=sys.stderr); sys.exit(1)

# Optional: target N keyframes evenly sampled from the source. Default uses
# every source frame, which is fine for small (4-frame) GIFs but produces
# too much data for long idle loops.
# Optional: noscale=1 disables the auto-downscale (preserves the original
# GIF pixel dimensions exactly — useful when an already-tiny source is
# being garbled by half-resolution sampling).
target_frames = None
force_no_downscale = False
name = ''
for a in sys.argv[2:]:
    if a.startswith('frames='):
        target_frames = int(a.split('=', 1)[1])
    elif a == 'noscale=1':
        force_no_downscale = True
    elif a.startswith('name='):
        name = a.split('=', 1)[1]

g = Image.open(sys.argv[1])
w, h = g.size
# Transparent = any pixel with alpha 0. Some palette-based GIFs put a
# garbage RGB behind the transparent index — collapse all alpha=0 into one
# sentinel so we don't accidentally treat them as multiple "real" colours.
TRANSPARENT = (0, 0, 0, 0)
def normalize(px):
    return TRANSPARENT if px[3] == 0 else px
g.seek(0)
bg = TRANSPARENT

# Find smallest horizontal run of non-bg pixels in frame 0 → intrinsic scale.
data0 = [normalize(p) for p in g.convert('RGBA').getdata()]
min_run = w
for y in range(h):
    cur_col = None; cur_len = 0
    for x in range(w):
        p = data0[y*w+x]
        if p == cur_col: cur_len += 1
        else:
            if cur_col is not None and cur_col != bg and cur_len > 1: min_run = min(min_run, cur_len)
            cur_col = p; cur_len = 1
scale = 1 if force_no_downscale else (min_run if min_run > 0 else 1)
out_w = w // scale; out_h = h // scale

# Decide which source frames to include. If --frames=N requested, sample N
# frames evenly across the animation; otherwise take all.
total = g.n_frames
if target_frames and target_frames < total:
    frame_indices = [round(i * total / target_frames) for i in range(target_frames)]
else:
    frame_indices = list(range(total))

frames = []
all_colours = []
for fi in frame_indices:
    g.seek(fi)
    rgba = g.convert('RGBA'); data = [normalize(p) for p in rgba.getdata()]
    small = []
    for y in range(out_h):
        for x in range(out_w):
            small.append(data[y*scale*w + x*scale])
    frames.append(small)
    all_colours.extend(small)

# Use the FULL native frame, not a tight bbox. Cropping individual frames
# would shift the silhouette between frames, and even a shared bbox loses
# the horizontal margin that gives the sprite its original aspect ratio
# (a tightly-cropped pikachu reads as vertically stretched vs the source).
min_x, min_y, max_x, max_y = 0, 0, out_w - 1, out_h - 1

# Palette: most-common colours first (sixel encoder enumerates per colour
# per band, so common colours up front shortens the output).
cnt = Counter(c for c in all_colours if c != bg)
palette = list(cnt.keys())  # already ordered by insertion = by frequency

CODES = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
def code(i): return CODES[i] if i < len(CODES) else '?'

W = max_x - min_x + 1; H = max_y - min_y + 1
import sys as _sys
W_BAR = '/' * 70
write = lambda s: _sys.stdout.write(s + '\n')

# Output naming: `name=PREFIX` (uppercased) prefixes everything so multiple
# sprite sets can coexist in the same file. With no name we use legacy names
# (PIKA_*) and emit the import line at the top.
prefix = name.upper() if name else 'PIKA'
emit_import = not name

write('// AUTO-GENERATED via trace-pika-gif.py -- do NOT hand-edit rows.')
write(f'// Source: {sys.argv[1]}')
write(f'// {W}x{H}, {len(frames)} frames, downscaled {scale}x from {w}x{h}.')
write('')
if emit_import:
    write("import { bitmapFromArt, type Bitmap, type Palette } from './sixel.js';")
    write('')
write(f'export const {prefix}_PALETTE: Palette = {{')
write('  colors: [')
for i, c in enumerate(palette):
    write(f'    [{c[0]:3d}, {c[1]:3d}, {c[2]:3d}],  // {i+1}')
write('  ],')
write('};')
write('')
write(f"const {prefix}_LEGEND: Record<string, number> = {{")
for i, _ in enumerate(palette):
    ch = code(i)
    write(f"  {repr(ch)}: {i+1},")
write('};')
write('')

for fi, small in enumerate(frames):
    write(f'const {prefix}_FRAME_{fi} = [')
    for y in range(min_y, max_y + 1):
        row = ''
        for x in range(min_x, max_x + 1):
            p = small[y*out_w + x]
            row += '.' if p == bg else code(palette.index(p))
        write(f"  '{row}',  // {y - min_y}")
    write('];')
    write('')

write(f'// {prefix} width validation — every row must be the same width.')
write(f'const {prefix}_WIDTH = {prefix}_FRAME_0[0]!.length;')
arr = ', '.join(f"['{i}', {prefix}_FRAME_{i}]" for i in range(len(frames)))
write(f'for (const [_n, frame] of [{arr}] as const) {{')
write('  for (let i = 0; i < frame.length; i++) {')
write(f'    if (frame[i]!.length !== {prefix}_WIDTH) {{')
write(f'      throw new Error(`{prefix} row ${{i}} has width ${{frame[i]!.length}}, expected ${{{prefix}_WIDTH}}`);')
write('    }')
write('  }')
write('}')
write('')
list_str = ', '.join(f'{prefix}_FRAME_{i}' for i in range(len(frames)))
write(f'export const {prefix}_FRAMES: ReadonlyArray<Bitmap> = [{list_str}]')
write(f'  .map(art => bitmapFromArt(art, {prefix}_LEGEND));')
