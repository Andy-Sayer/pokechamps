// Per-ACCOUNT login throttle — complements the per-IP rate limit (an attacker
// rotating IPs gets 5 tries per minute per IP forever; this caps tries against
// ONE account regardless of source). In-memory by design: the deploy target is
// a single small VM (see deploy notes), and a process restart resetting the
// counters is acceptable — the per-IP bucket still stands.
//
// Policy: 10 consecutive failures within the window locks the account's login
// for 15 minutes. A successful login clears the counter.

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

interface Entry { fails: number; windowStart: number; lockedUntil: number }
const entries = new Map<string, Entry>();

const keyOf = (email: string) => email.trim().toLowerCase();

/** True when this account's login is currently locked out. */
export function isLocked(email: string, now = Date.now()): boolean {
  const e = entries.get(keyOf(email));
  return !!e && e.lockedUntil > now;
}

/** Record a failed attempt; returns true if this failure tripped the lock. */
export function recordFailure(email: string, now = Date.now()): boolean {
  const k = keyOf(email);
  let e = entries.get(k);
  if (!e || now - e.windowStart > WINDOW_MS) {
    e = { fails: 0, windowStart: now, lockedUntil: 0 };
    entries.set(k, e);
  }
  e.fails += 1;
  if (e.fails >= MAX_FAILS) {
    e.lockedUntil = now + LOCK_MS;
    return true;
  }
  return false;
}

/** Clear the account's counter (successful login). */
export function clearFailures(email: string): void {
  entries.delete(keyOf(email));
}

/** Test hook: wipe all state. */
export function resetThrottle(): void {
  entries.clear();
}
