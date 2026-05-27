// Thin bcrypt wrappers. We use pure-JS bcryptjs (not the native `bcrypt`)
// so the server has no node-pre-gyp/tar dependency chain and the Docker image
// needs one fewer native build. bcryptjs is wire-compatible with bcrypt: it
// reads/writes the same $2a$/$2b$ hash format, so existing stored hashes keep
// verifying.
//
// Cost=12 ≈ 250ms/hash on modern hardware — slow enough to deter brute force,
// fast enough that interactive login feels instant. To bump cost, do it on
// next hash; verify still works against old hashes since the cost is encoded
// in the hash string itself.
import bcrypt from 'bcryptjs';

const COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
