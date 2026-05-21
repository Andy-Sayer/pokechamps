// ID + token generation. We use `crypto.randomUUID()` (RFC 4122 v4) for user
// and api_token row ids — same 122 bits of entropy as a ulid, but built into
// Node so we avoid pulling in a dep. The lexicographic-sort property of ulids
// isn't useful here since rows always carry a created_at column.
//
// API token secrets are 32 random bytes encoded base64url — 256 bits, no
// padding, no dots (so they never collide with the dot-separator we use to
// build the `<id>.<secret>` PAT-style token).
import { randomBytes, randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function newTokenSecret(): string {
  return randomBytes(32).toString('base64url');
}
