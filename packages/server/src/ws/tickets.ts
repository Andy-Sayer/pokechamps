// Short-lived single-use tickets for WebSocket authentication.
//
// Why this exists: browsers can't set arbitrary headers on the WS upgrade,
// so token-in-URL is the only browser-friendly way to authenticate. But
// putting a long-lived JWT or PAT in the URL leaks it to access logs, Fly's
// proxy logs, browser history, and Referer headers.
//
// The fix: clients POST /matches/:id/live-ticket (auth required) and get
// back a random 32-byte token scoped to (user, match). They use that on
// the WS upgrade URL. Tickets are single-use, 30s TTL, in-memory.
//
// This is process-local; a multi-instance deploy would need to swap to
// Redis or sticky-session the WS upgrade to the same machine that issued
// the ticket. Out of scope for the single-Fly-machine v1 deploy.
import { randomBytes } from 'node:crypto';

const TICKET_TTL_MS = 30_000;
const SWEEP_INTERVAL_MS = 60_000;

interface TicketEntry {
  userId: string;
  matchId: string;
  expiresAt: number;
}

const tickets = new Map<string, TicketEntry>();

// Periodic sweep so an idle process doesn't accumulate expired entries.
// unref()'d so the timer doesn't keep Node alive.
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tickets) {
    if (v.expiresAt <= now) tickets.delete(k);
  }
}, SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

export function issueTicket(userId: string, matchId: string): string {
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(ticket, {
    userId,
    matchId,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return ticket;
}

// Look up a ticket and delete it on success (single-use). Returns the
// (userId, matchId) pair on hit, null on miss / expired.
export function consumeTicket(
  ticket: string,
): { userId: string; matchId: string } | null {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (entry.expiresAt <= Date.now()) return null;
  return { userId: entry.userId, matchId: entry.matchId };
}

// Test-only: drop every ticket so cross-test state doesn't leak.
export function _resetTickets(): void {
  tickets.clear();
}

export function _ticketCount(): number {
  return tickets.size;
}
