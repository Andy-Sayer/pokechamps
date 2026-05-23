# Re-trace the Pikachu sprite from a PNG reference. Prints the cropped pixel
# grid in the string-art format pikaSprite.ts uses. Copy/paste the output
# rows into FRAME_CALM.
#
# Usage:
#   python packages/tui/src/scripts/trace-pika.py path/to/sprite.png
#
# Requires Pillow:  python -m pip install Pillow
#
# The current sprite in pikaSprite.ts was traced from:
#   https://img.pokemondb.net/sprites/silver/normal/pikachu.png
import sys
from PIL import Image
from collections import Counter

if len(sys.argv) != 2:
    print("usage: trace-pika.py <path-to-sprite.png>", file=sys.stderr)
    sys.exit(1)

img = Image.open(sys.argv[1]).convert('RGBA')
w, h = img.size
data = list(img.getdata())

# The "background" colour is the most-common pixel. (Silver sprites use solid
# white; other reference sprites may use transparent or another colour.)
bg = Counter(data).most_common(1)[0][0]

# Find bounding box of non-background pixels.
min_x, min_y, max_x, max_y = w, h, 0, 0
for y in range(h):
    for x in range(w):
        if data[y * w + x] != bg:
            min_x = min(min_x, x); min_y = min(min_y, y)
            max_x = max(max_x, x); max_y = max(max_y, y)

# Map the Silver-palette colours to the legend chars pikaSprite.ts uses.
# Add entries here if your reference sprite has additional shades.
COLOUR_TO_CHAR = {
    bg:                  '.',
    (239, 214, 41, 255): 'Y',
    (0,   0,   0,   255): 'K',
    (214, 49,  0,   255): 'R',
    (255, 255, 255, 255): 'W',
}


def ch(p):
    if p in COLOUR_TO_CHAR:
        return COLOUR_TO_CHAR[p]
    print(f"unknown colour {p}", file=sys.stderr)
    sys.exit(2)


W = max_x - min_x + 1
H = max_y - min_y + 1
print(f"// {W}x{H} — traced from {sys.argv[1]}")
for y in range(min_y, max_y + 1):
    row = ''.join(ch(data[y * w + x]) for x in range(min_x, max_x + 1))
    print(f"  '{row}',  // {y - min_y}")
