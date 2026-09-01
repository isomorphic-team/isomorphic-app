// D1, shimmed over `node:sqlite`. Node-only, so not in src/lib/.
//
// Every read goes through ensureFresh, which is D1 code, so anything running the real
// tools outside a Worker needs a D1-shaped database. e2e-librarian, e2e-import, and
// test-index each carried a near-identical copy of this shim; this is the one copy.
//
// Only the surface the index and the org tables use: prepare/bind, first, all, run,
// batch. D1 batches are transactional, so the shim is too; write-through relies on
// all page rows and the freshness marker committing or rolling back together.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

// Which migrations this database has already had. Wrangler keeps the same ledger
// against the real D1; without one here, every launch re-ran every file.
//
// That was invisible until a database OUTLIVED a process. Most callers pass
// `:memory:` or a fresh temp dir, so they only ever migrate an empty database and
// re-running is free — but `pnpm try` keeps its index in the brain's own
// `.isomorphic/`, on purpose, so a large vault is not reindexed on every launch.
// Its second launch on any folder died with `duplicate column name: schema_version`
// and stayed dead: `CREATE TABLE IF NOT EXISTS` is fine to repeat, and SQLite has no
// `ADD COLUMN IF NOT EXISTS`, so migrations 0002 and 0003 threw. The documented way
// in for a contributor with no accounts worked exactly once per folder.
const LEDGER = 'CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)';

// SQLite's complaint when a migration's effect is already in place. Treated as "this
// file has already been applied" rather than as a failure, which is what makes a
// database created BEFORE the ledger existed adopt itself instead of needing to be
// thrown away. Narrow on purpose: any other error is a real broken migration and
// still throws.
const ALREADY_APPLIED = /duplicate column name|already exists/i;

// The real migrations, not src/db/*.sql, which are reference copies. A migration that
// fails here would fail a deployment too.
export function applyMigrations(sqlite: DatabaseSync): void {
	sqlite.exec(LEDGER);
	const done = new Set(
		sqlite
			.prepare('SELECT name FROM local_migrations')
			.all()
			.map((r) => (r as { name: string }).name)
	);
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const f of files) {
		if (done.has(f)) continue;
		try {
			sqlite.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));
		} catch (e) {
			if (!ALREADY_APPLIED.test(String(e))) throw e;
		}
		// Recorded either way, so the self-healing pass above happens once rather than
		// on every launch forever.
		sqlite.prepare('INSERT OR IGNORE INTO local_migrations (name) VALUES (?)').run(f);
	}
}

export interface LocalDb {
	db: D1Database;
	sqlite: DatabaseSync;
}

// `path` defaults to an in-memory database. Pass a file to keep the content index
// across restarts, which is what the local runtime does.
export function localD1(path = ':memory:'): LocalDb {
	const sqlite = new DatabaseSync(path);
	applyMigrations(sqlite);

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
