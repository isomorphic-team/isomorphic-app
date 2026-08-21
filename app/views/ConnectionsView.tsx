// The shared spaces this brain is joined to, and anything waiting to be joined.
//
// ONE LIST, ONE ROW SHAPE. It used to be two lists with different rules, and the rows
// carried their state appended after a "·" to the counterparty, so a row said
// "Northwind Ltd · Waiting for them to join" and mixed an IDENTITY with a STATUS in one
// grey line. Which rows were clickable also varied silently. Now every row is a glyph,
// a name, who it is with, and a control on the right that says what you can do about
// it: nothing for the ordinary case, a chip when something is happening to it, a Join
// button when it is waiting for you.
//
// Creating is a pushed flow; ENDING is deliberately not here. It is destructive, it
// affects someone else's organization, and it is the one act that should cost a
// sentence rather than a click.
import { useState } from 'preact/hooks';
import type { ConnectionInvite, ConnectionRow } from '../core/types.ts';
import { switchBrain, openStartConnection, joinConnectionHere } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { LinkIcon } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';

// A chip is for something HAPPENING TO the connection, so a live one gets none: the
// normal case should be quiet, and a row reading "Live" would be a label every row
// carries and none of them needs.
function stateChip(state: string): string | null {
	if (state === 'pending') return 'Not joined yet';
	if (state === 'ending') return 'Ending';
	if (state === 'ended') return 'Ended';
	return null;
}

// Who is on the other side. A shared space rendered without its counterparty is just a
// name, and the counterparty is the one thing about it a person needs at a glance.
function counterparty(row: ConnectionRow): string {
	const theirs = row.parties.filter((p) => !p.mine);
	if (theirs.length === 0) return 'Just your organization';
	return theirs
		.map((p) => p.org ?? (p.invitedEmail ? `${p.invitedEmail}, invited` : 'Invited'))
		.join(', ');
}

const CHIP = 'shrink-0 rounded-full bg-chip px-2 py-0.5 text-xs text-muted';

// The shared geometry of every row here, so a joinable invitation and a live space read
// as the same kind of thing at different stages rather than as two features.
function Row({
	title,
	subtitle,
	onOpen,
	right
}: {
	title: string;
	subtitle: string;
	onOpen?: () => void;
	right?: preact.ComponentChildren;
}) {
	const body = (
		<>
			<span class="shrink-0 text-accent">
				<LinkIcon />
			</span>
			<span class="min-w-0 flex-1">
				<span class={`block truncate ${onOpen ? 'text-fg' : 'text-muted'}`}>{title}</span>
				<span class="block truncate text-xs text-muted">{subtitle}</span>
			</span>
		</>
	);
	return (
		<div class="flex items-center gap-2 rounded px-1 py-2 hover:bg-chip">
			{onOpen ? (
				<button
					type="button"
					onClick={onOpen}
					class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:text-accent"
				>
					{body}
				</button>
			) : (
				<span class="flex min-w-0 flex-1 items-center gap-2">{body}</span>
			)}
			{right}
		</div>
	);
}

function ConnectionsView({
	brainLabel,
	connections,
	invitations,
	canCreate
}: {
	brainLabel: string;
	connections: ConnectionRow[];
	invitations: ConnectionInvite[];
	canCreate: boolean;
}) {
	const [joining, setJoining] = useState<string | null>(null);

	async function join(inv: ConnectionInvite) {
		if (joining) return;
		setJoining(inv.connection_id);
		const err = await joinConnectionHere(inv.name, brainLabel);
		setJoining(null);
		if (err) toast(err, true);
	}

	const empty = connections.length === 0 && invitations.length === 0;

	return (
		<div class="flex flex-col">
			{empty ? (
				<div class="mt-8 text-center text-muted">
					<div class="text-fg">No shared spaces yet.</div>
					<p class="mx-auto mt-2 max-w-sm text-sm">
						A shared space is one set of pages you and another organization both write in, owned by
						neither of you. Anyone who can open “{brainLabel}” would be able to open it.
					</p>
					{!canCreate && (
						<p class="mx-auto mt-2 max-w-sm text-sm">
							An admin of your organization can start one.
						</p>
					)}
				</div>
			) : (
				<div>
					{invitations.map((inv) => (
						<Row
							key={inv.connection_id}
							title={inv.name}
							// An invitation cannot be opened, so its subtitle answers the only
							// question left: who is asking.
							subtitle={inv.from ? `${inv.from} invited you` : 'You were invited'}
							right={
								<button
									type="button"
									onClick={() => void join(inv)}
									disabled={joining === inv.connection_id}
									class="shrink-0 cursor-pointer rounded-md border border-border px-2 py-1 text-xs text-fg hover:border-accent hover:text-accent disabled:opacity-50"
									title={`Join it to ${brainLabel}`}
								>
									{joining === inv.connection_id ? 'Joining…' : 'Join'}
								</button>
							}
						/>
					))}
					{connections.map((c) => {
						// An ENDED space cannot be opened: its anchors are detached and its
						// brain is archived, so a row that looked clickable would be a control
						// whose click is refused. A pending one CAN be, by the side that
						// started it, which has to be able to prepare the room before anyone
						// is invited to look at it.
						const open = c.state === 'live' || c.state === 'pending';
						const chip = stateChip(c.state);
						return (
							<Row
								key={c.connection_id}
								title={c.name}
								subtitle={`with ${counterparty(c)}`}
								// switchBrain, not a peek: entering a shared space moves the crumb,
								// the file tree and the path policy with it, through the one seam
								// that drops what belonged to the brain being left. A second brain
								// rendered under the first brain's name is issue #26.
								onOpen={open ? () => switchBrain(c.brain) : undefined}
								right={chip ? <span class={CHIP}>{chip}</span> : undefined}
							/>
						);
					})}
				</div>
			)}

			{/* The access rule, once, under the list rather than on every row. It is the
			    same sentence for all of them, and repeating it per row is what made the
			    old subtitles carry status they had no room for. */}
			{!empty && (
				<p class="mt-3 border-t border-border pt-3 text-xs text-muted">
					Anyone who can open “{brainLabel}” can open these. Change who that is in Sharing.
				</p>
			)}
		</div>
	);
}

export { ConnectionsView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		connections: {
			brainLabel: string;
			connections: ConnectionRow[];
			invitations: ConnectionInvite[];
			canCreate: boolean;
		};
	}
}

export default defineView(
	'connections',
	(v) => (
		<ConnectionsView
			brainLabel={v.brainLabel}
			connections={v.connections}
			invitations={v.invitations}
			canCreate={v.canCreate}
		/>
	),
	{
		// Gated on the payload's own answer, not on a guess: starting one is an org-admin
		// act, and a widget cannot ask the host which tools it may call. A control whose
		// click is refused is worse than no control.
		actions: (v) =>
			v.canCreate
				? [
						{
							key: 'start-connection',
							label: 'Start',
							title: `Start a shared space, joined to ${v.brainLabel}`,
							onClick: () => openStartConnection(v.brainLabel)
						}
					]
				: []
	}
);
