// ---------- brain access (sharing) view ----------

import { useEffect, useState } from 'preact/hooks';
import type { BrainAccessEntry, BrainAccessSelf } from '../core/types.ts';
import { callTool, firstText } from '../core/host.ts';
import {
	refreshBrainAccess,
	openShareBrain,
	openConnections,
	ensureConnections
} from '../core/actions.ts';
import { activeBrain, connectionList, features } from '../core/store.ts';
import { toast } from '../core/toast.tsx';
import { InitialsAvatar, CloseIcon } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';
import { RoleSelect, ROLE_LABEL } from '../components/RoleSelect.tsx';
import { Button, List, ListRow } from '../ui/index.ts';

// A POINTER, NOT A SECTION. Sharing is the page someone opens when they are nervous
// about a leak, and connections are the other half of the thought that brings them here:
// what this brain is joined to. So the question gets an answer without the two lists
// being merged, which they must not be.
//
// Access runs ONE WAY, and that is the whole reason this is a link rather than rows.
// Reaching this brain gets you into the rooms it anchors; being in one of those rooms
// gets you nothing here (listAccessibleBrains walks memberships → anchor → connection
// and never the reverse). A room listed among the people who can see this brain would
// read as the opposite of that, on the one page where being wrong about it matters.
//
// Rendered only when there is something to point AT. `connectionList` is null until it
// has been fetched and stays null when the fetch fails, so an unknown answer shows
// nothing rather than claiming none.
function AlsoJoinedTo({ brainId }: { brainId: string }) {
	useEffect(() => {
		void ensureConnections();
	}, [features.connections]);
	// The store holds the connections of the ACTIVE brain, and this panel can be opened
	// for a named one (the Share control in the brains list). brain_access is registered
	// sticky so the two are normally the same, and this says so out loud rather than
	// trusting it: naming one brain's rooms under another brain's page is issue #26 in
	// miniature.
	if (activeBrain?.id !== brainId) return null;
	const rooms = (connectionList ?? []).filter((c) => c.state === 'live' || c.state === 'pending');
	if (rooms.length === 0) return null;
	return (
		<button
			type="button"
			onClick={() => openConnections(brainId)}
			class="mt-4 flex w-full items-center gap-1 border-t border-border pt-3 text-left text-sm text-muted hover:text-fg"
		>
			<span>
				Also joined to {rooms.length} shared {rooms.length === 1 ? 'space' : 'spaces'}
			</span>
			<span aria-hidden="true">→</span>
		</button>
	);
}

// Per-brain sharing: who can reach THIS brain, at what level, and whether it's
// private or open to the whole organization. The brain-scope sibling of MembersView
// (which is the org roster), same shape one scope down, so the two read as the same
// surface at different altitudes.
//
// Only brain admins get controls. Everyone else sees the list plainly, and the
// absence of controls is the signal that they can't manage it (show, don't tell).
//
// Adding someone opens its own view (ShareBrainView) from the header, not a composer
// in this list. See app/ui/Flow.tsx.
function BrainAccessView({
	access,
	visibility,
	brainId,
	brainLabel,
	me
}: {
	access: BrainAccessEntry[];
	visibility: string;
	brainId: string;
	brainLabel: string;
	me: BrainAccessSelf;
}) {
	// Gated on the BRAIN role, not the org role: an org admin has it via the floor, a
	// creator via their own grant, and someone shared in as editor deliberately does not.
	const canManage = me.role === 'admin' || me.role === 'owner';
	const isPrivate = visibility === 'private';
	const [busy, setBusy] = useState(false);

	async function run(args: Record<string, unknown>) {
		if (busy) return;
		setBusy(true);
		const res = await callTool('share_brain', { brain: brainId, ...args });
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast(firstText(res));
		refreshBrainAccess((res.structuredContent ?? {}) as Record<string, unknown>);
	}

	return (
		<div>
			{/* Visibility is the headline fact: "private" and "everyone in the org" are
			    materially different answers to "who can see this?", so it leads rather
			    than hiding in a row. */}
			<div class="mb-4 flex items-start gap-3 rounded-md border border-border p-3">
				<div class="min-w-0 flex-1">
					<div class="text-sm font-medium text-fg">
						{isPrivate ? 'Private' : 'Everyone in the organization'}
					</div>
					<div class="mt-0.5 text-xs text-muted">
						{isPrivate
							? `Only the people listed below can open ${brainLabel}.`
							: `Every member of the organization can open ${brainLabel}.`}
					</div>
				</div>
				{canManage && (
					<Button
						variant="outline"
						size="xs"
						disabled={busy}
						onClick={() => run({ visibility: isPrivate ? 'org' : 'private' })}
					>
						{isPrivate ? 'Share with organization' : 'Make private'}
					</Button>
				)}
			</div>

			<List>
				{access.map((a) => {
					const isSelf = a.user_id === me.user_id;
					// Only an explicit share can be edited or revoked. Access inherited from
					// org visibility or the org-admin floor has no row to change; offering a
					// control that silently does nothing is worse than none.
					const editable = canManage && !isSelf && a.via === 'grant';
					return (
						<ListRow key={a.user_id}>
							<InitialsAvatar name={a.name || a.email} />
							<div class="min-w-0 flex-1">
								<div class="flex items-baseline gap-2">
									<span class="truncate font-medium text-fg" title={a.name || a.email}>
										{a.name || a.email}
									</span>
									{isSelf && <span class="shrink-0 text-xs text-muted">You</span>}
								</div>
								<div class="truncate text-xs text-muted">
									{a.via === 'grant'
										? a.name
											? a.email
											: 'Shared directly'
										: a.via === 'org'
											? 'Via organization'
											: 'Organization admin'}
								</div>
							</div>
							{editable ? (
								<RoleSelect
									value={a.role}
									disabled={busy}
									onChange={(r) => {
										if (r !== a.role) run({ email: a.email, access: r });
									}}
								/>
							) : (
								<span class="shrink-0 text-sm text-muted">{ROLE_LABEL[a.role]}</span>
							)}
							{editable && (
								<Button
									variant="ghost"
									size="icon"
									disabled={busy}
									title={`Remove ${a.email}'s access`}
									aria-label={`Remove ${a.email}'s access`}
									onClick={() => run({ email: a.email, access: 'none' })}
								>
									<CloseIcon />
								</Button>
							)}
						</ListRow>
					);
				})}
			</List>

			{access.length === 0 && (
				<div class="py-6 text-center text-sm text-muted">Nobody else has access yet.</div>
			)}

			<AlsoJoinedTo brainId={brainId} />
		</div>
	);
}

export { BrainAccessView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		'brain-access': {
			access: BrainAccessEntry[];
			visibility: string;
			brainId: string;
			brainLabel: string;
			me: BrainAccessSelf;
		};
	}
}

export default defineView(
	'brain-access',
	(v) => (
		<BrainAccessView
			access={v.access}
			visibility={v.visibility}
			brainId={v.brainId}
			brainLabel={v.brainLabel}
			me={v.me}
		/>
	),
	{
		// Gated on the BRAIN role, same as the in-view controls: someone who can only
		// read the brain never sees a Share they cannot use.
		actions: (v) =>
			v.me.role === 'admin' || v.me.role === 'owner'
				? [
						{
							key: 'share-brain',
							label: 'Share',
							title: `Share ${v.brainLabel} with someone`,
							onClick: () => openShareBrain(v.brainId, v.brainLabel)
						}
					]
				: []
	}
);
