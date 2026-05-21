// Thin bcrypt wrappers. Cost=12 ≈ 250ms/hash on modern hardware — slow enough
// to deter brute force, fast enough that interactive login feels instant.
// If we ever need to bump cost, do it on next hash (verify still works against
// old hashes since bcrypt encodes the cost in the hash string itself).
import bcrypt from 'bcrypt';

const COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
