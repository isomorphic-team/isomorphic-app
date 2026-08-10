// Usage analytics: the pure layer.
//
// Everything here is a total function over plain data. No D1, no octokit, no
// clock beyond what the caller passes in, so `pnpm test:usage` can walk the whole
// thing. The impure halves live in src/worker.ts (recording one row per tool
// call) and src/tools/analytics.ts (the query and the widget payload).
//
// WHAT THESE NUMBERS ARE, AND ARE NOT. Rows are recorded when a tool call passes
// through this Worker, so the tab measures USE OF THE PRODUCT. It does not
// measure repository activity: an edit made on github.com, by a merged PR, or by
// another agent holding the repo token never touches a tool handler and is
// invisible here. That is the honest reading of the data and the tab says so
// (see FOOTNOTE below), because the alternative is a "0 edits" row next to a
// member who spent the week editing the brain on GitHub.

/** Whether a tool call was a read, a change to content, or an act of administration. */
export type UsageKind = 'read' | 'write' | 'admin';

/**
 * How each first-party tool counts.
 *
 * ADDING A TOOL MEANS ADDING IT HERE. An unlisted name falls through to 'read'
 * (see classifyTool), which is right for brain-authored `tool_*` pages, whose
 * three kinds are read-only by construction, and wrong for a new write tool. The
 * golden test pins this map against the list of tools the server actually
 * registers so the omission surfaces as a red test rather than as a quietly
 * under-counted write column.
 */
export const TOOL_KINDS: Record<string, UsageKind> = {
	// Reads. The bulk of ordinary use.
	search_pages: 'read',
	read_page: 'read',
	view_page: 'read',
	list_pages: 'read',
	browse_brain: 'read',
	find_inbound_links: 'read',
	view_graph: 'read',
	view_activity: 'read',
	validate: 'read',
	brains: 'read',
	switch_brain: 'read',
	brain_access: 'read',
	members: 'read',
	whoami: 'read',
	connected_accounts: 'read',
	analytics: 'read',

	// Writes: anything that changes brain content.
	write_page: 'write',
	set_fields: 'write',
	move_page: 'write',
	delete_page: 'write',
	sync_records: 'write',
	resolve_import: 'write',
	configure_brain: 'write',
	// The editor opens here and saves through write_page. Counted as a write
	// because it records the INTENT to edit, which is the thing the tab is asked
	// about ("is anyone actually maintaining this brain?").
	edit_page: 'write',

	// Administration: people, brains, and the wiring between them. Kept apart from
	// writes so a busy month of onboarding does not read as a busy month of
	// authoring.
	create_brain: 'admin',
	connect_brain: 'admin',
	disconnect_brain: 'admin',
	share_brain: 'admin',
	invite_member: 'admin',
	set_member_role: 'admin',
	remove_member: 'admin',
	connect_github_org: 'admin',
	link_identity: 'admin',
	unlink_identity: 'admin',
	submit_feedback: 'admin'
};

/**
 * Read/write/admin for a tool name. Unknown names count as reads: the only
 * unknown names that legitimately reach here are brain-authored `tool_*` pages,
 * and all three of their kinds (prompt / bound-op / view) are read-only by
 * construction. See the note on TOOL_KINDS about first-party additions.
 */
export function classifyTool(tool: string): UsageKind {
	return TOOL_KINDS[tool] ?? 'read';
}

// ---------- counting a tool call ----------

/**
 * Wrap a tool handler so its outcome is counted, without changing what it does.
 *
 * Lives here, pure, rather than inline in worker.ts because it is the riskiest
 * few lines in the feature: it replaces the callback the MCP SDK will invoke, so
 * a mistake does not under-count analytics, it breaks every tool on the server.
 * Extracted so `pnpm test:usage` can drive all five paths (sync return, sync
 * throw, async resolve, async reject, and the `isError` result that never threw).
 *
 * Contract:
 *   • The result is passed through untouched, and a throw is rethrown untouched.
 *   • A resolved `{ isError: true }` counts as an ERROR. It did not throw, and
 *     counting it as success would hide exactly the tools that are failing people.
 *   • `before` runs first on every call, so the caller can reset per-call state
 *     (worker.ts clears the resolved scope, so a call that resolves no org records
 *     nothing rather than borrowing the previous call's org).
 *   • `after` runs exactly once per call, never twice, on every path.
 */
export function countedCall<A extends unknown[]>(
	inner: (...args: A) => unknown,
	hooks: { before?: () => void; after: (ok: boolean) => void }
): (...args: A) => unknown {
	const isErrorResult = (r: unknown) =>
		!!(r && typeof r === 'object' && 'isError' in r && (r as { isError?: unknown }).isError);
	return (...args: A) => {
		hooks.before?.();
		let result: unknown;
		try {
			result = inner(...args);
		} catch (e) {
			hooks.after(false);
			throw e;
		}
		if (result instanceof Promise) {
			return result.then(
				(r) => {
					hooks.after(!isErrorResult(r));
					return r;
				},
				(e) => {
					hooks.after(false);
					throw e;
				}
			);
		}
		hooks.after(!isErrorResult(result));
		return result;
	};
}

// ---------- days ----------

/** The UTC day a moment falls in, as 'YYYY-MM-DD'. */
export function dayKey(at: Date): string {
	return at.toISOString().slice(0, 10);
}

/** `day` moved by `delta` days, staying in UTC. */
export function shiftDay(day: string, delta: number): string {
	const t = Date.parse(`${day}T00:00:00Z`);
	if (Number.isNaN(t)) throw new Error(`shiftDay: not a YYYY-MM-DD day: "${day}"`);
	return dayKey(new Date(t + delta * 86_400_000));
}

/** Every day in [from, to] inclusive, ascending. Empty when the range inverts. */
export function daysBetween(from: string, to: string): string[] {
	const out: string[] = [];
	for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(d);
	return out;
}

// ---------- shapes ----------

/** One `usage_daily` row, as read back out of D1. */
export interface UsageRow {
	day: string;
	user_id: string;
	/** '' for org-scope calls that resolved no brain (see migration 0006). */
	brain_id: string;
	tool: string;
	calls: number;
	errors: number;
}

/** A current org member, from the roster. */
export interface RosterEntry {
	user_id: string;
	name: string | null;
	email: string;
	role: string;
}

/** Display name for a brain the org owns. */
export interface BrainLabel {
	brain_id: string;
	label: string;
}

export interface PersonUsage {
	user_id: string;
	name: string | null;
	email: string | null;
	role: string | null;
	reads: number;
	writes: number;
	admin: number;
	/** Most recent day with any recorded call, or null if never active in window. */
	lastActive: string | null;
	/**
	 * Recorded activity from a user who is no longer on the roster. Their calls
	 * still count toward org totals, so listing them is what keeps the People
	 * table adding up to the tiles above it.
	 */
	former: boolean;
}

export interface BrainUsage {
	brain_id: string;
	label: string;
	reads: number;
	writes: number;
	/** Distinct people who touched this brain in the window. */
	people: number;
	lastActive: string | null;
}

export interface UsageSummary {
	window: { from: string; to: string; days: number };
	totals: {
		/** Distinct users with any recorded call in the window. */
		activeUsers: number;
		/** Current roster size, for the "N of M" reading. */
		members: number;
		reads: number;
		writes: number;
		admin: number;
		calls: number;
		errors: number;
	};
	/** One entry per day in the window, gaps filled with zeroes. */
	series: { day: string; reads: number; writes: number }[];
	/** Sorted by activity, then name. Includes zero rows: those are the point. */
	people: PersonUsage[];
	/** Brains with recorded activity, plus every known brain at zero. */
	brains: BrainUsage[];
}

export interface SummarizeInput {
	rows: UsageRow[];
	roster: RosterEntry[];
	brains: BrainLabel[];
	from: string;
	to: string;
}

/**
 * Fold raw counter rows into everything the tab renders.
 *
 * Rows outside [from, to] are ignored rather than trusted, so a caller that
 * widens its SQL window cannot silently change what the tiles claim to cover.
 */
export function summarize({ rows, roster, brains, from, to }: SummarizeInput): UsageSummary {
	const inWindow = rows.filter((r) => r.day >= from && r.day <= to);

	// Accumulators are keyed by UsageKind ('read' | 'write' | 'admin') so a row can
	// index them directly; the plural names appear once, on the way out.
	type Tally = Record<UsageKind, number>;
	const zero = (): Tally => ({ read: 0, write: 0, admin: 0 });

	const totals = { ...zero(), calls: 0, errors: 0 };
	const byDay = new Map<string, Tally>();
	const byPerson = new Map<string, Tally & { last: string }>();
	const byBrain = new Map<string, Tally & { last: string; people: Set<string> }>();

	for (const r of inWindow) {
		const kind = classifyTool(r.tool);
		const calls = Math.max(0, r.calls | 0);
		if (calls === 0 && r.errors === 0) continue;

		totals[kind] += calls;
		totals.calls += calls;
		totals.errors += Math.max(0, r.errors | 0);

		const d = byDay.get(r.day) ?? zero();
		d[kind] += calls;
		byDay.set(r.day, d);

		const p = byPerson.get(r.user_id) ?? { ...zero(), last: '' };
		p[kind] += calls;
		if (r.day > p.last) p.last = r.day;
		byPerson.set(r.user_id, p);

		// Org-scope calls carry no brain (''), so they count toward the person and
		// the org totals but belong to no brain row.
		if (r.brain_id) {
			const b = byBrain.get(r.brain_id) ?? { ...zero(), last: '', people: new Set<string>() };
			b[kind] += calls;
			if (r.day > b.last) b.last = r.day;
			b.people.add(r.user_id);
			byBrain.set(r.brain_id, b);
		}
	}

	// The chart plots reads against edits. Admin calls are counted everywhere else
	// but deliberately left off it: a day of inviting people is not a day of use,
	// and folding it in would make onboarding week look like the busiest week the
	// brain ever had.
	const series = daysBetween(from, to).map((day) => ({
		day,
		reads: byDay.get(day)?.read ?? 0,
		writes: byDay.get(day)?.write ?? 0
	}));

	// Every current member gets a row, active or not. A member at zero is the most
	// actionable line on the page, so it is never filtered out, only sorted down.
	const people: PersonUsage[] = roster.map((m) => {
		const p = byPerson.get(m.user_id);
		return {
			user_id: m.user_id,
			name: m.name,
			email: m.email,
			role: m.role,
			reads: p?.read ?? 0,
			writes: p?.write ?? 0,
			admin: p?.admin ?? 0,
			lastActive: p?.last || null,
			former: false
		};
	});
	const onRoster = new Set(roster.map((m) => m.user_id));
	for (const [user_id, p] of byPerson) {
		if (onRoster.has(user_id)) continue;
		people.push({
			user_id,
			name: null,
			email: null,
			role: null,
			reads: p.read,
			writes: p.write,
			admin: p.admin,
			lastActive: p.last || null,
			former: true
		});
	}
	const personLabel = (p: PersonUsage) => (p.name || p.email || p.user_id).toLowerCase();
	people.sort(
		(a, b) =>
			b.reads + b.writes + b.admin - (a.reads + a.writes + a.admin) ||
			personLabel(a).localeCompare(personLabel(b))
	);

	// Known brains first (so a brain nobody opened still shows, at zero), then any
	// brain_id with rows that the caller did not label (disconnected since).
	const labelled = new Map(brains.map((b) => [b.brain_id, b.label]));
	const brainIds = [...new Set([...labelled.keys(), ...byBrain.keys()])];
	const brainRows: BrainUsage[] = brainIds.map((brain_id) => {
		const b = byBrain.get(brain_id);
		return {
			brain_id,
			label: labelled.get(brain_id) ?? brain_id,
			reads: b?.read ?? 0,
			writes: b?.write ?? 0,
			people: b?.people.size ?? 0,
			lastActive: b?.last || null
		};
	});
	brainRows.sort(
		(a, b) => b.reads + b.writes - (a.reads + a.writes) || a.label.localeCompare(b.label)
	);

	return {
		window: { from, to, days: daysBetween(from, to).length },
		totals: {
			activeUsers: byPerson.size,
			members: roster.length,
			reads: totals.read,
			writes: totals.write,
			admin: totals.admin,
			calls: totals.calls,
			errors: totals.errors
		},
		series,
		people,
		brains: brainRows
	};
}

/**
 * The caveat that has to travel with these numbers wherever they are rendered.
 * Kept here so the widget and the text summary cannot drift into claiming
 * different things.
 */
export const FOOTNOTE =
	'Counts activity in Isomorphic only. Edits made directly on GitHub are not included.';

/** Plain-text summary, for hosts with no widget and for the model to reason over. */
export function summaryText(s: UsageSummary, orgName: string): string {
	const lines = [
		`Usage for ${orgName}, ${s.window.from} to ${s.window.to} (${s.window.days} days):`,
		`- Active members: ${s.totals.activeUsers} of ${s.totals.members}`,
		`- Reads: ${s.totals.reads}`,
		`- Edits: ${s.totals.writes}`
	];
	if (s.brains.length) {
		lines.push('', 'By brain:');
		for (const b of s.brains) {
			lines.push(
				`- ${b.label}: ${b.reads} reads, ${b.writes} edits, ${b.people} ${
					b.people === 1 ? 'person' : 'people'
				}${b.lastActive ? `, last active ${b.lastActive}` : ', no activity'}`
			);
		}
	}
	if (s.people.length) {
		lines.push('', 'By person:');
		for (const p of s.people) {
			const who = p.name || p.email || (p.former ? 'Removed member' : p.user_id);
			lines.push(
				`- ${who}: ${p.reads} reads, ${p.writes} edits${
					p.lastActive ? `, last active ${p.lastActive}` : ', never active'
				}`
			);
		}
	}
	lines.push('', FOOTNOTE);
	return lines.join('\n');
}
