import { describe, test, expect } from 'vitest';
import { statusBerryFor, isStatusBerry } from '../src/domain/statusBerries.js';

describe('statusBerryFor', () => {
  test('Lum cures any non-volatile status', () => {
    expect(statusBerryFor('Lum Berry', 'brn')).toEqual({ consumed: 'Lum Berry' });
    expect(statusBerryFor('Lum Berry', 'par')).toEqual({ consumed: 'Lum Berry' });
    expect(statusBerryFor('Lum Berry', 'tox')).toEqual({ consumed: 'Lum Berry' });
    expect(statusBerryFor('Lum Berry', 'slp')).toEqual({ consumed: 'Lum Berry' });
    expect(statusBerryFor('Lum Berry', 'frz')).toEqual({ consumed: 'Lum Berry' });
  });

  test('specific berries cure only their own status', () => {
    expect(statusBerryFor('Cheri Berry', 'par')!.consumed).toBe('Cheri Berry');
    expect(statusBerryFor('Cheri Berry', 'brn')).toBeNull();

    expect(statusBerryFor('Rawst Berry', 'brn')!.consumed).toBe('Rawst Berry');
    expect(statusBerryFor('Rawst Berry', 'frz')).toBeNull();

    expect(statusBerryFor('Aspear Berry', 'frz')!.consumed).toBe('Aspear Berry');
    expect(statusBerryFor('Aspear Berry', 'brn')).toBeNull();

    expect(statusBerryFor('Chesto Berry', 'slp')!.consumed).toBe('Chesto Berry');
    expect(statusBerryFor('Chesto Berry', 'par')).toBeNull();
  });

  test('Pecha cures both psn and tox', () => {
    expect(statusBerryFor('Pecha Berry', 'psn')!.consumed).toBe('Pecha Berry');
    expect(statusBerryFor('Pecha Berry', 'tox')!.consumed).toBe('Pecha Berry');
    expect(statusBerryFor('Pecha Berry', 'brn')).toBeNull();
  });

  test('returns null for non-berry items', () => {
    expect(statusBerryFor('Leftovers', 'brn')).toBeNull();
    expect(statusBerryFor('Sitrus Berry', 'brn')).toBeNull(); // not a status berry
  });

  test('returns null for undefined item (already consumed)', () => {
    expect(statusBerryFor(undefined, 'brn')).toBeNull();
  });

  test('returns null when no status is being applied', () => {
    expect(statusBerryFor('Lum Berry', null)).toBeNull();
    expect(statusBerryFor('Lum Berry', undefined)).toBeNull();
  });
});

describe('isStatusBerry', () => {
  test('recognises all status berries', () => {
    expect(isStatusBerry('Lum Berry')).toBe(true);
    expect(isStatusBerry('Cheri Berry')).toBe(true);
    expect(isStatusBerry('Chesto Berry')).toBe(true);
    expect(isStatusBerry('Pecha Berry')).toBe(true);
    expect(isStatusBerry('Rawst Berry')).toBe(true);
    expect(isStatusBerry('Aspear Berry')).toBe(true);
  });

  test('rejects non-status items', () => {
    expect(isStatusBerry('Sitrus Berry')).toBe(false);
    expect(isStatusBerry('Salac Berry')).toBe(false);
    expect(isStatusBerry('Leftovers')).toBe(false);
    expect(isStatusBerry(undefined)).toBe(false);
  });
});
