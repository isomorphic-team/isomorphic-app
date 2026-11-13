// The SQL storage a Durable Object has, as the code in src/lib/ that runs on it takes it:
// `ctx.storage` deployed, node:sqlite in the batteries (scripts/sqlite-database.ts).
// Runtime-portable (Worker-safe, no node:*).

export interface SqlRunner {
	exec(query: string, ...bindings: (string | number | null)[]): { toArray(): unknown[] };
}

export interface SqlDatabase {
	sql: SqlRunner;
	// Runs `fn` so that its statements land together or not at all.
	transaction<T>(fn: () => T): T;
}
