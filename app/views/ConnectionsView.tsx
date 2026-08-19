// The connections panel: what this brain is joined to, and what is waiting for you.
//
// Deliberately read-only. Creating or ending a connection is an org-admin act with real
// consequences on someone else's side, and it is done by asking rather than by clicking:
// there is no form here that could be filled in halfway. The panel answers "who are we
// sharing a space with", which is the question people actually open it for.
import type { ConnectionInvite, ConnectionRow } from '../core/types.ts';
import { defineView } from '../core/view-registry.ts';
import { List, ListRow } from '../ui/List.tsx';

function stateNote(state: string): string {
	if (state === 'pending') return 'Waiting for them to join';
	if (state === 'ending') return 'Ending; copies are being made';
	if (state === 'ended') return 'Ended';
	return '';
}

// Who is on the other side. A connection rendered without its counterparty is just a
// name, and the counterparty is the one thing about it a person needs at a glance.
function counterparty(row: ConnectionRow): string {
	const theirs = row.parties.filter((p) => !p.mine);
	if (theirs.length === 0) return 'Just your organization';
	return theirs
		.map((p) => p.org ?? (p.invitedEmail ? `${p.invitedEmail} (invited)` : 'Invited'))
		.join(', ');
}

function ConnectionsView({
	brainLabel,
	connections,
	invitations
}: {
	brainLabel: string;
	connections: ConnectionRow[];
	invitations: ConnectionInvite[];
}) {
	return (
		<div class="flex flex-col gap-4">
			{connections.length === 0 ? (
				<div class="mt-6 text-center text-muted">
					<div>“{brainLabel}” is not connected to anything.</div>
					<p class="mx-auto mt-2 max-w-sm text-sm">
						A connection is a space you share with another organization: one set of pages that both
						sides write in, owned by neither. Ask to start one.
					</p>
				</div>
			) : (
				<div>
					<div class="px-1 pb-1.5 text-xs text-muted">Shared with</div>
					<List>
						{connections.map((c) => (
							<ListRow key={c.connection_id}>
								<span class="min-w-0 flex-1">
									<span class="block truncate text-fg">{c.name}</span>
									<span class="block text-xs text-muted">
										{counterparty(c)}
										{stateNote(c.state) ? ` · ${stateNote(c.state)}` : ''}
									</span>
								</span>
							</ListRow>
						))}
					</List>
				</div>
			)}

			{invitations.length > 0 && (
				<div>
					{/* Invitations are listed apart from connections because they are not
					    reachable yet: until you join one to a brain of your own, there is no
					    brain for it to hang off and nobody on your side can open it. */}
					<div class="px-1 pb-1.5 text-xs text-muted">Waiting for you</div>
					<List>
						{invitations.map((i) => (
							<ListRow key={i.connection_id}>
								<span class="min-w-0 flex-1">
									<span class="block truncate text-fg">{i.name}</span>
									<span class="block text-xs text-muted">
										Ask to join it, naming one of your brains
									</span>
								</span>
							</ListRow>
						))}
					</List>
				</div>
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
		};
	}
}

export default defineView('connections', (v) => (
	<ConnectionsView
		brainLabel={v.brainLabel}
		connections={v.connections}
		invitations={v.invitations}
	/>
));
