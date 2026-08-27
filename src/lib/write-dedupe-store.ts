// The write-attempt ledger's durable half (migration 0007). Kept apart from
// src/lib/write-dedupe.ts so that file stays pure and fully testable; everything
// here is one statement against `write_attempts`.
//
// Worker-safe: no node:* imports.

import type { D1Database } from '@cloudflare/workers-types';
import { IN_FLIGHT_GRACE_MS, type WriteAttempt, type WriteLedger } from './write-dedupe.ts';

interface Row {
	brain_id: string;
	fingerprint: string;
	state: string;
	started_at: number;
	completed_at: number | null;
	summary: string | null;
}

function toAttempt(row: Row): WriteAttempt {
	return {
		brainId: row.brain_id,
		fingerprint: row.fingerprint,
		state: row.state === 'done' ? 'done' : 'in_flight',
		startedAt: row.started_at,
		completedAt: row.completed_at,
		summary: row.summary
	};
}

export function d1WriteLedger(db: D1Database): WriteLedger {
	return {
		async prune({ inFlightBefore, doneBefore }) {
			await db
				.prepare(
					`DELETE FROM write_attempts
					 WHERE (state = 'in_flight' AND started_at < ?1)
					    OR (state = 'done' AND COALESCE(completed_at, started_at) < ?2)`
				)
				.bind(inFlightBefore, doneBefore)
				.run();
		},

		/**
		 * ONE STATEMENT, because two would race. An insert wins the claim outright;
		 * the DO UPDATE arm takes over a claim whose owner is past the grace window
		 * and is therefore never coming back (a Worker killed mid-request leaves a
		 * row nobody will finish, and a permanently blocked fingerprint would be
		 * worse than the duplicate this prevents). A conflict with a LIVE in-flight
		 * row, or with a completed one, changes nothing and loses the claim —
		 * which is what tells the caller to go read the row and replay it.
		 */
		async claim(brainId, fingerprint, now) {
			const res = await db
				.prepare(
					`INSERT INTO write_attempts
					   (brain_id, fingerprint, state, started_at, completed_at, summary)
					 VALUES (?1, ?2, 'in_flight', ?3, NULL, NULL)
					 ON CONFLICT (brain_id, fingerprint) DO UPDATE
					   SET state = 'in_flight', started_at = ?3,
					       completed_at = NULL, summary = NULL
					   WHERE write_attempts.state = 'in_flight'
					     AND write_attempts.started_at < ?4`
				)
				.bind(brainId, fingerprint, now, now - IN_FLIGHT_GRACE_MS)
				.run();
			return (res.meta?.changes ?? 0) > 0;
		},

		async read(brainId, fingerprint) {
			const row = await db
				.prepare(`SELECT * FROM write_attempts WHERE brain_id = ?1 AND fingerprint = ?2`)
				.bind(brainId, fingerprint)
				.first<Row>();
			return row ? toAttempt(row) : null;
		},

		async complete(brainId, fingerprint, at, summary) {
			await db
				.prepare(
					`UPDATE write_attempts
					    SET state = 'done', completed_at = ?3, summary = ?4
					  WHERE brain_id = ?1 AND fingerprint = ?2`
				)
				.bind(brainId, fingerprint, at, summary)
				.run();
		},

		async release(brainId, fingerprint) {
			await db
				.prepare(`DELETE FROM write_attempts WHERE brain_id = ?1 AND fingerprint = ?2`)
				.bind(brainId, fingerprint)
				.run();
		}
	};
}
