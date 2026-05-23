// Preview both Pikachu sprite sets as sixel. Run via:
//   npm -w @pokechamps/tui run preview-pika
// Requires a sixel-capable terminal (Windows Terminal Preview ≥1.22, etc.).
import {
  IDLE_FRAMES, IDLE_PALETTE,
  RUN_FRAMES, RUN_PALETTE,
} from '../ui/pikaSprite.js';
import { encodeSixel } from '../ui/sixel.js';

const scale = Number(process.env.SCALE ?? 1);

process.stdout.write('\nIDLE (Black/White):\n');
for (let i = 0; i < IDLE_FRAMES.length; i++) {
  process.stdout.write(encodeSixel(IDLE_FRAMES[i]!, IDLE_PALETTE, { scale }));
  process.stdout.write(' ');
}
process.stdout.write('\n\nRUN (running):\n');
for (let i = 0; i < RUN_FRAMES.length; i++) {
  process.stdout.write(encodeSixel(RUN_FRAMES[i]!, RUN_PALETTE, { scale }));
  process.stdout.write(' ');
}
process.stdout.write('\n');
