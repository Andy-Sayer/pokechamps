// Sqlite connection singleton. Single-writer, low-concurrency app — WAL mode
// + NORMAL sync is the right tradeoff for durability vs. speed. Foreign keys
// are OFF by default in sqlite (!), so we always enable them.
import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const url = process.env.DATABASE_URL ?? 'file:./data/pokechamps.db';
  if (!url.startsWith('file:')) {
    throw new Error(`DATABASE_URL must be a file: URL for sqlite. Got: ${url}`);
  }
  const path = url.slice('file:'.length);
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');     // better-sqlite3 default but explicit
  db.pragma('synchronous = NORMAL');   // safe with WAL; faster than FULL
  db.pragma('foreign_keys = ON');      // OFF by default in sqlite (!)
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
