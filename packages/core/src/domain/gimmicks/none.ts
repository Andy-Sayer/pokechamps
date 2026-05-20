import type { Gimmick } from './types.js';

// Null-object Gimmick. Every hook is omitted so dispatch is a no-op.
export const noneGimmick: Gimmick = {
  id: 'none',
  label: 'None',
};
