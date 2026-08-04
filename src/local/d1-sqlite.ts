// D1, shimmed over `node:sqlite`. Node-only, so not in src/lib/.
//
// Every read goes through ensureFresh, which is D1 code, so anything running the real
// tools outside a Worker needs a D1-shaped database. e2e-librarian, e2e-import, and
// test-index each carried a near-identical copy of this shim; this is the one copy.
//
// Only the surface the index and the org tables use: prepare/bind, first, all, run,
// batch. `batch` is sequential rather than transactional, matching how the tools use
// it (idempotent upserts).

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

// The real migrations, not src/db/*.sql, which are reference copies. A migration that
// fails here would fail a deployment too.
export function applyMigrations(sqlite: DatabaseSync): void {
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const f of files) {
		sqlite.exec(readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));
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
				sqlite.prepare(sql).run(...(params as []));
				return { success: true };
			}
		};
	}

	const db = {
		prepare: (sql: string) => statement(sql),
		batch: async (stmts: { run: () => Promise<unknown> }[]) => {
			for (const s of stmts) await s.run();
			return [];
		}
	} as unknown as D1Database;

	return { db, sqlite };
}
