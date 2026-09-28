// Moving a brain to another organization.
//
// A move changes who OWNS a brain and nothing about where it is STORED: the brain
// keeps its storage binding, so it is read through the same credential after the
// move as before. Grants, visibility, read-only, name, brain_id, the content index
// and the web URL are untouched. docs/design/storage-and-tenancy.md §5.
//
// What a move does change is who reaches the brain, since two of
// effectiveBrainRole's three sources (org visibility, the org-admin floor) are
// about membership in the owning org. `planBrainMove` computes that change for
// every affected person by running the rule twice, once per org, so the preview is
// the rule's own answer rather than a second copy of it.

import type { D1Database } from '@cloudflare/workers-types';
import { type Role, accessVia, effectiveBrainRole, roleLabel } from './orgs.ts';

export interface MovePerson {
	user_id: string;
	email: string;
	sourceRole: Role | null; // their role in the org the brain leaves
	destRole: Role | null; // their role in the org it joins
	grant: Role | null; // their explicit grant on the brain, which moves with it
}

export type MoveOutcome = 'unchanged' | 'changed' | 'loses' | 'gains';

export interface MoveChange {
	user_id: string;
	email: string;
	before: Role | null;
	after: Role | null;
	// How `after` is reached, when it is: a guest is capped at editor, which is the
	// change most likely to surprise, so the preview names it.
	afterVia?: ReturnType<typeof accessVia>;
	outcome: MoveOutcome;
}

export function planBrainMove(input: {
	visibility: string;
	readOnly: boolean;
	people: MovePerson[];
}): MoveChange[] {
	const { visibility, readOnly } = input;
	const out: MoveChange[] = [];
	for (const p of input.people) {
		const before = effectiveBrainRole({
			visibility,
			orgRole: p.sourceRole,
			grant: p.grant,
			readOnly
		});
		const after = effectiveBrainRole({ visibility, orgRole: p.destRole, grant: p.grant, readOnly });
		if (!before && !after) continue; // never reached it, still does not
		const outcome: MoveOutcome = !after
			? 'loses'
			: !before
				? 'gains'
				: before === after
					? 'unchanged'
					: 'changed';
		out.push({
			user_id: p.user_id,
			email: p.email,
			before,
			after,
			...(after
				? { afterVia: accessVia({ visibility, orgRole: p.destRole, grant: p.grant }) }
				: {}),
			outcome
		});
	}
	const rank: Record<MoveOutcome, number> = { loses: 0, changed: 1, gains: 2, unchanged: 3 };
	return out.sort((a, b) => rank[a.outcome] - rank[b.outcome] || a.email.localeCompare(b.email));
}

// Everyone a move could affect: members of either org and holders of a grant on
// the brain, each with their role on both sides.
export async function loadMovePeople(
	db: D1Database,
	input: { brainId: string; fromOrgId: string; toOrgId: string }
): Promise<MovePerson[]> {
	const { results } = await db
		.prepare(
			`SELECT u.user_id AS user_id, u.email AS email,
			        ms.role AS source_role, md.role AS dest_role, bm.role AS grant_role
			   FROM app_users u
			   LEFT JOIN memberships ms ON ms.org_id = ?2 AND ms.user_id = u.user_id
			   LEFT JOIN memberships md ON md.org_id = ?3 AND md.user_id = u.user_id
			   LEFT JOIN brain_memberships bm ON bm.brain_id = ?1 AND bm.user_id = u.user_id
			  WHERE ms.user_id IS NOT NULL OR md.user_id IS NOT NULL OR bm.user_id IS NOT NULL`
		)
		.bind(input.brainId, input.fromOrgId, input.toOrgId)
		.all<{
			user_id: string;
			email: string;
			source_role: string | null;
			dest_role: string | null;
			grant_role: string | null;
		}>();
	return (results ?? []).map((r) => ({
		user_id: r.user_id,
		email: r.email,
		sourceRole: r.source_role as Role | null,
		destRole: r.dest_role as Role | null,
		grant: r.grant_role as Role | null
	}));
}

export async function countPendingBrainInvites(db: D1Database, brainId: string): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM invitations
			  WHERE brain_id = ?1 AND accepted_at IS NULL AND expires_at > datetime('now')`
		)
		.bind(brainId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

// The move itself, in one batch so it lands whole or not at all. The brain's
// storage binding is untouched: it is read through the same connection after the
// move as before.
export async function moveBrain(
	db: D1Database,
	input: { brainId: string; toOrgId: string }
): Promise<void> {
	await db.batch([
		db
			.prepare(`UPDATE brains SET org_id = ?2 WHERE brain_id = ?1`)
			.bind(input.brainId, input.toOrgId),
		// A pending brain invite carries the brain's org, so a claim after the move
		// has to name the org the brain is now in.
		db
			.prepare(`UPDATE invitations SET org_id = ?2 WHERE brain_id = ?1 AND accepted_at IS NULL`)
			.bind(input.brainId, input.toOrgId)
	]);
}

// The preview a move answers with before it is confirmed. Every person whose access
// changes is named; the unchanged are counted, since on a large org listing them
// buries the lines that matter.
export function describeMove(input: {
	brain: string;
	from: string;
	to: string;
	storageAccount: string;
	changes: MoveChange[];
	pendingInvites: number;
}): string {
	const role = (r: Role | null) => (r ? roleLabel(r) : 'no access');
	const why = (c: MoveChange): string => {
		if (c.outcome === 'loses') return ` (not a member of ${input.to} and holds no grant)`;
		if (c.afterVia === 'guest') return ` (guest: not a member of ${input.to}, capped at Editor)`;
		if (c.outcome === 'gains' && c.afterVia === 'org') return ` (member of ${input.to})`;
		if (c.afterVia === 'org-admin') return ` (${input.to} admin)`;
		return '';
	};
	const moved = input.changes.filter((c) => c.outcome !== 'unchanged');
	const same = input.changes.filter((c) => c.outcome === 'unchanged');
	const lines = [
		`Move "${input.brain}" from ${input.from} to ${input.to}?`,
		'',
		`Storage stays where it is: ${input.storageAccount}. A move changes which organization owns the brain, not where it is stored.`,
		''
	];
	if (moved.length) {
		lines.push('Access that changes:');
		for (const c of moved)
			lines.push(`- ${c.email}: ${role(c.before)} → ${role(c.after)}${why(c)}`);
	} else {
		lines.push('Nobody’s access changes.');
	}
	if (same.length) {
		const who = same.map((c) => c.email).join(', ');
		lines.push(`Unchanged: ${same.length} ${same.length === 1 ? 'person' : 'people'} (${who}).`);
	}
	if (input.pendingInvites) {
		const n = input.pendingInvites;
		lines.push(`${n} pending ${n === 1 ? 'invitation moves' : 'invitations move'} with it.`);
	}
	lines.push(
		`Usage history stays with ${input.from}.`,
		'',
		'Nothing has changed yet. Call connect_brain again with confirm: true to move it.'
	);
	return lines.join('\n');
}
