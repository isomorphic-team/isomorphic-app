// D1, shimmed over `node:sqlite`. Node-only (see the note at the top of
// brain-store-fs.ts about why this is not in src/lib/).
//
// The content index is D1 code, and it is not optional: every read goes through
// ensureFresh. So anything that runs the real tools outside a Worker needs a D1 that
// behaves like D1. Three places did: e2e-librarian, e2e-import, and test-index each
// carried their own near-identical copy of this shim. This is that copy, once, so the
// local runtime and the e2e batteries cannot drift from each other.
//
// Only the surface the index and the org tables actually use: prepare/bind, first,
// all, run, and batch. `batch` is sequential rather than a real transaction, which
// matches how the tools use it (idempotent upserts) and is the same compromise the
// e2e scripts have always made.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

// Apply the REAL migrations rather than src/db/*.sql, which are reference copies.
// If a migration would not apply here, it would not apply to a deployment either,
// so this is worth a few milliseconds at startup.
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
// across restarts, which is what the local runtime does: rebuilding the index of a
// large vault on every launch is slow and pointless.
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
