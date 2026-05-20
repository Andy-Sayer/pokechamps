// File-based migration runner. Each *.sql under ./migrations/ runs once, in
// filename order, inside a transaction. Applied names are recorded in a
// _migrations table so re-runs are no-ops. Migrations are expand-only — see
// ./migrations/README.md.
import type Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export interface MigrateResult {
  applied: string[];
  latest: string | null;
}

export function migrate(db: Database.Database): MigrateResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  const alreadyApplied = new Set(
    db.prepare<[], { name: string }>('SELECT name FROM _migrations').all().map(r => r.name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const recordStmt = db.prepare(
    'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    const name = file.replace(/\.sql$/, '');
    if (alreadyApplied.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const run = db.transaction(() => {
      // Empty SQL (e.g., a placeholder migration with only comments) is fine —
      // better-sqlite3's exec() accepts a no-op string.
      if (sql.trim().length > 0) db.exec(sql);
      recordStmt.run(name, new Date().toISOString());
    });
    run();
    applied.push(name);
  }

  const latestRow = db
    .prepare<[], { name: string }>('SELECT name FROM _migrations ORDER BY id DESC LIMIT 1')
    .get();

  return { applied, latest: latestRow?.name ?? null };
}
