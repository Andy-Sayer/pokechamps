// Default turn counts for timed effects (Gen 8/9). All are overridable — these
// are just what we seed when the effect is first logged. The countdown ticks in
// endOfTurn and the effect clears at 0.
//   Weather / Trick Room: 5 turns (8 with the matching rock, but we default 5
//     and let the user override). Taunt / Encore: 3. Disable: 4.
export const EFFECT_DURATIONS = {
  weather: 5,
  trickRoom: 5,
  taunt: 3,
  encore: 3,
  disable: 4,
} as const;
