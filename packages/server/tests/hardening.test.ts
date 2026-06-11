// Theme 5 medium security items: per-account login throttle, credential body
// limits, generic 5xx error responses, WS payload cap registration.
import { describe, test, expect, beforeEach } from 'vitest';
import { isLocked, recordFailure, clearFailures, resetThrottle } from '../src/auth/loginThrottle.js';

describe('per-account login throttle', () => {
  beforeEach(() => resetThrottle());

  test('locks after 10 failures within the window, regardless of source IP', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 9; i++) expect(recordFailure('User@Example.com', t0 + i)).toBe(false);
    expect(isLocked('user@example.com', t0 + 9)).toBe(false);
    expect(recordFailure('USER@example.com', t0 + 10)).toBe(true); // 10th trips
    expect(isLocked('user@example.com', t0 + 11)).toBe(true);
    // …and stays locked for 15 minutes.
    expect(isLocked('user@example.com', t0 + 14 * 60 * 1000)).toBe(true);
    expect(isLocked('user@example.com', t0 + 16 * 60 * 1000)).toBe(false);
  });

  test('a success clears the counter', () => {
    const t0 = 0;
    for (let i = 0; i < 9; i++) recordFailure('a@b.c', t0 + i);
    clearFailures('a@b.c');
    expect(recordFailure('a@b.c', t0 + 20)).toBe(false); // fresh count
    expect(isLocked('a@b.c', t0 + 21)).toBe(false);
  });

  test('failures outside the window reset the count', () => {
    const t0 = 0;
    for (let i = 0; i < 9; i++) recordFailure('a@b.c', t0 + i);
    // 16 minutes later — old window expired, this is failure #1 again.
    expect(recordFailure('a@b.c', t0 + 16 * 60 * 1000)).toBe(false);
    expect(isLocked('a@b.c', t0 + 16 * 60 * 1000 + 1)).toBe(false);
  });

  test('accounts are isolated', () => {
    for (let i = 0; i < 10; i++) recordFailure('victim@x.y', i);
    expect(isLocked('victim@x.y', 11)).toBe(true);
    expect(isLocked('other@x.y', 11)).toBe(false);
  });
});
