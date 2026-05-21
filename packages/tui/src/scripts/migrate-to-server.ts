// One-shot migration: push every local team + match to a remote
// @pokechamps/server. Idempotent for teams (PUT /teams/:name is upsert);
// matches always get a fresh server-assigned id, no client-side dedupe.
//
// Run via: npm --workspace @pokechamps/tui run migrate-to-server
//
// Exit codes: 0 = everything uploaded cleanly; 1 = any failure (including
// missing config). The progress log is the user-facing report — keep it
// terse, one line per item.
import { listTeams, listMatches } from '@pokechamps/core/domain/storage.js';
import type { PokemonSet, Match } from '@pokechamps/core/domain/types.js';
import { loadConfig } from '../config.js';

interface UploadResult {
  ok: boolean;
  status?: number;
  message?: string;
}

async function putTeam(
  serverUrl: string,
  token: string,
  name: string,
  team: PokemonSet[],
): Promise<UploadResult> {
  // PUT /teams/:name is an upsert (ON CONFLICT DO UPDATE in the server),
  // so re-running the migration just overwrites with the latest local copy.
  try {
    const res = await fetch(`${serverUrl}/teams/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ team }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, message: truncate(body) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

async function postMatch(
  serverUrl: string,
  token: string,
  match: Match,
): Promise<UploadResult> {
  // Server overwrites match.id with a UUID; we don't try to preserve the
  // local filename id. Re-running this script will duplicate matches — by
  // design, since matches are append-only event logs and there's no
  // natural unique key the server could honour.
  try {
    const res = await fetch(`${serverUrl}/matches`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ match }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, message: truncate(body) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function truncate(s: string, max = 120): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function formatFail(result: UploadResult): string {
  const parts: string[] = [];
  if (result.status !== undefined) parts.push(`HTTP ${result.status}`);
  if (result.message) parts.push(result.message);
  return parts.join(' ') || 'unknown error';
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  if (!cfg.serverUrl || !cfg.token) {
    // Friendly nudge toward the in-TUI flow that populates ~/.pokechamps/config.json
    console.error(
      'No server URL or token in config. Run Server settings → connect + log in first.',
    );
    return 1;
  }
  const serverUrl = cfg.serverUrl.replace(/\/$/, '');

  let teamsOk = 0;
  let teamsFail = 0;
  let matchesOk = 0;
  let matchesFail = 0;

  const teams = listTeams();
  for (const { name, team } of teams) {
    const result = await putTeam(serverUrl, cfg.token, name, team);
    if (result.ok) {
      teamsOk++;
      console.log(`✓ team "${name}"`);
    } else {
      teamsFail++;
      console.log(`✗ team "${name}": ${formatFail(result)}`);
    }
  }

  const matches = listMatches();
  for (const { id, match } of matches) {
    const result = await postMatch(serverUrl, cfg.token, match);
    if (result.ok) {
      matchesOk++;
      console.log(`✓ match ${id}`);
    } else {
      matchesFail++;
      console.log(`✗ match ${id}: ${formatFail(result)}`);
    }
  }

  console.log(
    `\nTeams: ${teamsOk} uploaded, ${teamsFail} failed. ` +
      `Matches: ${matchesOk} uploaded, ${matchesFail} failed.`,
  );
  return teamsFail + matchesFail === 0 ? 0 : 1;
}

main().then(
  code => process.exit(code),
  err => {
    console.error('Migration crashed:', err);
    process.exit(1);
  },
);
