// D1, shimmed over `node:sqlite`. Node-only, so not in src/lib/.
//
// Every read goes through ensureFresh, which is D1 code, so anything running the real
// tools outside a Worker needs a D1-shaped database. This is the one shim the local
// runtime and the offline batteries share.
//
// Only the surface the index and the org tables use: prepare/bind, first, all, run,
// batch. D1 batches are transactional, so the shim is too; write-through relies on
// all page rows and the freshness marker committing or rolling back together.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';
import { D1_LIKE_PATTERN_LIMIT } from '../lib/brain-index.ts';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
// The index database's own migrations (the INDEX_DB binding).
export const INDEX_MIGRATIONS_DIR = new URL('../../migrations-index/', import.meta.url);

// Which migrations this database has already had, the same ledger Wrangler keeps
// against the real D1. It matters once a database outlives a process: `pnpm try`
// keeps its index in the brain's own `.isomorphic/`, and re-running a migration is
// not safe (SQLite has no `ADD COLUMN IF NOT EXISTS`, so 0002 and 0003 would throw
// `duplicate column name`).
const LEDGER = 'CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)';

// SQLite's complaint when a migration's effect is already in place. Treated as "this
// file has already been applied" rather than as a failure, which is what makes a
// database created BEFORE the ledger existed adopt itself instead of needing to be
// thrown away. Narrow on purpose: any other error is a real broken migration and
// still throws.
const ALREADY_APPLIED = /duplicate column name|already exists/i;

const migrationFiles = (dir: URL = MIGRATIONS_DIR): string[] =>
	readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();

const migrationSql = (f: string, dir: URL = MIGRATIONS_DIR): string =>
	readFileSync(new URL(f, dir), 'utf8');

// The real migrations, not src/db/*.sql, which are reference copies. A migration that
// fails here would fail a deployment too.
export function applyMigrations(sqlite: DatabaseSync, dir: URL = MIGRATIONS_DIR): void {
	sqlite.exec(LEDGER);
	const done = new Set(
		sqlite
			.prepare('SELECT name FROM local_migrations')
			.all()
			.map((r) => (r as { name: string }).name)
	);
	for (const f of migrationFiles(dir)) {
		if (done.has(f)) continue;
		try {
			sqlite.exec(migrationSql(f, dir));
		} catch (e) {
			if (!ALREADY_APPLIED.test(String(e))) throw e;
		}
		// Recorded either way, so the self-healing pass above happens once rather than
		// on every launch forever.
		sqlite.prepare('INSERT OR IGNORE INTO local_migrations (name) VALUES (?)').run(f);
	}
}

// Runs the migrations numbered from `from` (inclusive) up to `to` (exclusive), by their
// four-digit prefix, with no ledger and no tolerance for an already-applied file. That
// is a database as a deployment had it at a given version, which a backfill test needs:
// localD1 applies every migration to an empty database, where a backfill has nothing
// to do. With no range it runs them all, which is a database from before the ledger.
export function replayMigrations(
	sqlite: DatabaseSync,
	range: { from?: string; to?: string } = {}
): void {
	for (const f of migrationFiles()) {
		if (range.from !== undefined && f < range.from) continue;
		if (range.to !== undefined && f >= range.to) continue;
		sqlite.exec(migrationSql(f));
	}
}

export interface LocalDb {
	db: D1Database;
	sqlite: DatabaseSync;
}

// `migrations` picks the schema: the platform database's by default, or
// INDEX_MIGRATIONS_DIR for a database holding only the content index.
// `path` defaults to an in-memory database. Pass a file to keep the content index
// across restarts, which is what the local runtime does.
export function localD1(path = ':memory:', migrations: URL = MIGRATIONS_DIR): LocalDb {
	const sqlite = new DatabaseSync(path);
	// D1's cap, so a query that D1 rejects fails here too.
	sqlite.limits.likePatternLength = D1_LIKE_PATTERN_LIMIT;
	applyMigrations(sqlite, migrations);

	function statement(sql: string, params: unknown[] = []) {
		return {
			bind: (...p: unknown[]) => statement(sql, p),
			first: async () => sqlite.prepare(sql).get(...(params as [])) ?? null,
			all: async () => ({ results: sqlite.prepare(sql).all(...(params as [])) }),
			run: async () => {
				const result = sqlite.prepare(sql).run(...(params as []));
				return { success: true, meta: { changes: Number(result.changes) } };
			}
		};
	}

	const db = {
		prepare: (sql: string) => statement(sql),
		batch: async (stmts: { run: () => Promise<unknown> }[]) => {
			const results: unknown[] = [];
			sqlite.exec('BEGIN');
			try {
				for (const s of stmts) results.push(await s.run());
				sqlite.exec('COMMIT');
				return results;
			} catch (err) {
				sqlite.exec('ROLLBACK');
				throw err;
			}
		}
	} as unknown as D1Database;

	return { db, sqlite };
}
