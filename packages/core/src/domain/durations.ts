// Default turn counts for timed effects (Gen 8/9). All are overridable — these
// are just what we seed when the effect is first logged. The countdown ticks in
// endOfTurn and the effect clears at 0.
//   Weather / Trick Room: 5 turns (8 with the matching rock, but we default 5
//     and let the user override). Taunt / Encore: 3. Disable: 4.
export const EFFECT_DURATIONS = {
  weather: 5,
  trickRoom: 5,
  tailwind: 4,
  taunt: 3,
  encore: 3,
  disable: 4,
} as const;

// Extended-duration items. When held by the weather/screen setter, these items
// extend the base duration from 5 to 8 turns (weather) or 5 to 8 (screens).
const WEATHER_DURATION_ITEMS: Record<string, string> = {
  'Damp Rock': 'Rain',
  'Heat Rock': 'Sun',
  'Smooth Rock': 'Sand',
  'Icy Rock': 'Snow',
};

const SCREEN_DURATION_ITEM = 'Light Clay';

// Returns the duration for a weather effect, adjusted if the setter holds the
// matching rock. Defaults to EFFECT_DURATIONS.weather (5 turns); with the rock,
// returns 8 turns. Only valid if the setter is known to hold the item.
export function weatherDuration(item?: string | null): number {
  if (!item) return EFFECT_DURATIONS.weather;
  return Object.keys(WEATHER_DURATION_ITEMS).includes(item) ? 8 : EFFECT_DURATIONS.weather;
}

// Returns the duration for a screen/reflect/light-screen/aurora-veil effect,
// adjusted if the setter holds Light Clay. Defaults to EFFECT_DURATIONS.weather
// (5 turns); with Light Clay, returns 8 turns.
export function screenDuration(item?: string | null): number {
  return item === SCREEN_DURATION_ITEM ? 8 : EFFECT_DURATIONS.weather;
}
