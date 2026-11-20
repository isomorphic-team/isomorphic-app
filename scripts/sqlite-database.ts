// An in-memory SQLite database shaped like a Durable Object's storage, for the batteries
// that run src/lib/ code written against it (src/lib/sql-storage.ts) under Node.

import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase } from '../src/lib/sql-storage.ts';

export function sqliteDatabase(): SqlDatabase {
	const db = new DatabaseSync(':memory:');
	return {
		sql: {
			// Eager, as a Durable Object's exec is: the statement runs before the cursor is read.
			exec: (query, ...bindings) => {
				const rows = db.prepare(query).all(...bindings);
				return { toArray: () => rows };
			}
		},
		transaction: (fn) => {
			db.exec('BEGIN');
			try {
				const result = fn();
				db.exec('COMMIT');
				return result;
			} catch (e) {
				db.exec('ROLLBACK');
				throw e;
			}
		}
	};
}
