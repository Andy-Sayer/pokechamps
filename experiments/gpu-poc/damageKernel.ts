/**
 * The GPU-amenable slice of a Pokemon damage calc: the base-damage formula plus
 * the 16-roll random spread. This is the pure arithmetic inner loop — exactly the
 * piece a "GPU damage kernel" would own. All categorical/branchy work (type chart,
 * abilities, items, STAB, weather, spread) is assumed PRE-RESOLVED on the CPU into
 * the four numeric inputs below (and, in a real integration, one extra fixed-point
 * multiplier applied as a final GPU multiply — omitted here so we can validate the
 * kernel BIT-EXACTLY against @smogon/calc on neutral, no-modifier cases).
 *
 * Gen 5+ base damage (single target, no crit/weather/STAB/type mods):
 *   base = floor( floor( (floor(2L/5)+2) * BP * A / D ) / 50 ) + 2
 *   roll_k = floor( base * (85+k) / 100 )   for k in 0..15
 * All inputs positive, so i32 truncating division == floor.
 */

export interface DmgInput {
  level: number;   // 1..100
  bp: number;      // move base power
  atk: number;     // attacker effective attacking stat
  def: number;     // defender effective defending stat
}

export const ROLLS = 16;

/** CPU reference: writes 16 rolls for input i into out[i*16 .. i*16+15]. */
export function cpuRolls(level: Int32Array, bp: Int32Array, atk: Int32Array, def: Int32Array, out: Int32Array): void {
  const n = level.length;
  for (let i = 0; i < n; i++) {
    const lvlTerm = Math.floor((2 * level[i]!) / 5) + 2;
    const base = Math.floor(Math.floor((lvlTerm * bp[i]! * atk[i]!) / def[i]!) / 50) + 2;
    const o = i * ROLLS;
    for (let k = 0; k < ROLLS; k++) {
      out[o + k] = Math.floor((base * (85 + k)) / 100);
    }
  }
}

/** Single-tuple reference (validation against @smogon/calc). */
export function cpuRollsOne(inp: DmgInput): number[] {
  const lvlTerm = Math.floor((2 * inp.level) / 5) + 2;
  const base = Math.floor(Math.floor((lvlTerm * inp.bp * inp.atk) / inp.def) / 50) + 2;
  const out: number[] = [];
  for (let k = 0; k < ROLLS; k++) out.push(Math.floor((base * (85 + k)) / 100));
  return out;
}

/**
 * WGSL compute shader: one invocation per input tuple, writes 16 i32 rolls.
 * Inputs are four parallel i32 storage arrays; output is a flat i32 array of
 * n*16. WGSL i32 `/` truncates toward zero == floor for the positive operands.
 */
export const WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read>       level : array<i32>;
@group(0) @binding(1) var<storage, read>       bp    : array<i32>;
@group(0) @binding(2) var<storage, read>       atk   : array<i32>;
@group(0) @binding(3) var<storage, read>       def   : array<i32>;
@group(0) @binding(4) var<storage, read_write> outp  : array<i32>;
@group(0) @binding(5) var<uniform>             n     : u32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= n) { return; }
  let lvlTerm = (2 * level[i]) / 5 + 2;
  let base = ((lvlTerm * bp[i] * atk[i]) / def[i]) / 50 + 2;
  let o = i * 16u;
  for (var k = 0u; k < 16u; k = k + 1u) {
    outp[o + k] = (base * (85 + i32(k))) / 100;
  }
}
`;
