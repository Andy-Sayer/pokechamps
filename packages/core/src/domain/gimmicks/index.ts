import type { Gimmick, GimmickId } from './types.js';
import { noneGimmick } from './none.js';
import { megaGimmick } from './mega.js';
import { teraGimmick } from './tera.js';
import { zmoveGimmick } from './zmove.js';
import { dynamaxGimmick } from './dynamax.js';

const REGISTRY: Record<GimmickId, Gimmick> = {
  none: noneGimmick,
  mega: megaGimmick,
  tera: teraGimmick,
  zmove: zmoveGimmick,
  dynamax: dynamaxGimmick,
};

export function getGimmick(id: GimmickId): Gimmick {
  return REGISTRY[id] ?? noneGimmick;
}

// Resolve the active gimmick lazily to avoid a circular import with data.ts
// (data.ts depends on types only; this module depends on the format JSON
// via the loader, which is read on demand).
let formatLoader: (() => { gimmick: GimmickId }) | null = null;
export function _setFormatLoader(fn: () => { gimmick: GimmickId }) {
  formatLoader = fn;
}

export function activeGimmick(): Gimmick {
  if (!formatLoader) return noneGimmick;
  return getGimmick(formatLoader().gimmick);
}

export type { Gimmick, GimmickId } from './types.js';
