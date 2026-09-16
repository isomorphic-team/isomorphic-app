// ---------- brain access (sharing) view ----------

import { useState } from 'preact/hooks';
import type { BrainAccessEntry, BrainAccessSelf, Invite } from '../core/types.ts';
import { relativeTime } from '../core/util.ts';
import { callTool, firstText } from '../core/host.ts';
import { refreshBrainAccess, openShareBrain } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { InitialsAvatar, CloseIcon } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';
import { RoleSelect, ROLE_LABEL, GUEST_ROLES } from '../components/RoleSelect.tsx';
import { Button, List, ListRow } from '../ui/index.ts';
import { eyebrow } from '../ui/typography.ts';

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
	invites,
	visibility,
	brainId,
	brainLabel,
	me
}: {
	access: BrainAccessEntry[];
	// Shares to addresses with no account yet (guests-to-be): the only evidence,
	// until they sign in, that the share happened.
	invites: Invite[];
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
					const editable = canManage && !isSelf && (a.via === 'grant' || a.via === 'guest');
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
										: a.via === 'guest'
											? a.name
												? `Guest · ${a.email}`
												: 'Guest · not in the organization'
											: a.via === 'org'
												? 'Via organization'
												: 'Organization admin'}
								</div>
							</div>
							{editable ? (
								<RoleSelect
									value={a.role}
									disabled={busy}
									roles={a.via === 'guest' ? GUEST_ROLES : undefined}
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

			{invites.length > 0 && (
				<div class="mt-6">
					<div class={`mb-1.5 ${eyebrow}`}>Invited</div>
					<List>
						{invites.map((inv) => (
							<ListRow key={inv.invite_id}>
								<span
									class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-dashed border-border text-2xs text-muted"
									aria-hidden="true"
								>
									@
								</span>
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm text-fg" title={inv.email}>
										{inv.email}
									</div>
									<div class="text-xs text-muted" title={inv.invited_at || undefined}>
										Guest once they sign in · invited
										{inv.invited_at ? ` ${relativeTime(inv.invited_at)}` : ''}
									</div>
								</div>
								<span class="shrink-0 text-sm text-muted">{ROLE_LABEL[inv.role]}</span>
								{canManage && (
									<Button
										variant="ghost"
										size="icon"
										disabled={busy}
										title={`Cancel invite for ${inv.email}`}
										aria-label={`Cancel invite for ${inv.email}`}
										onClick={() => run({ email: inv.email, access: 'none' })}
									>
										<CloseIcon />
									</Button>
								)}
							</ListRow>
						))}
					</List>
				</div>
			)}
		</div>
	);
}

export { BrainAccessView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		'brain-access': {
			access: BrainAccessEntry[];
			invites: Invite[];
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
			invites={v.invites}
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
