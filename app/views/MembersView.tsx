// ---------- members view ----------

import { useState } from 'preact/hooks';
import type { Member, Invite, MemberSelf } from '../core/types.ts';
import { callTool, firstText } from '../core/host.ts';
import { refreshMembers, openInviteMember } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { relativeTime } from '../core/util.ts';
import { InitialsAvatar, CloseIcon } from '../core/icons.tsx';
import { RoleSelect, ROLE_LABEL } from '../components/RoleSelect.tsx';
import { defineView } from '../core/view-registry.ts';
import { Button, List, ListRow } from '../ui/index.ts';
import { eyebrow } from '../ui/typography.ts';

// Org roster: who's in the org, their role, and pending invites. Any member sees
// the list; admins get inline role dropdowns and a remove control. Non-admins see
// plain role text — the presence/absence of controls IS the signal that you can
// manage (show, don't tell), so there's no explanatory copy.
//
// Inviting is a header action that opens its own view (InviteMemberView), not a
// composer in this list. See app/ui/Flow.tsx.
function MembersView({
	members,
	invites,
	me
}: {
	members: Member[];
	invites: Invite[];
	me: MemberSelf;
}) {
	const canManage = me.role === 'admin' || me.role === 'owner';
	const [busy, setBusy] = useState(false);

	// Run a member mutation, refresh the roster from its result, toast the outcome.
	async function run(tool: string, args: Record<string, unknown>) {
		if (busy) return;
		setBusy(true);
		const res = await callTool(tool, args);
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast(firstText(res));
		refreshMembers((res.structuredContent ?? {}) as Record<string, unknown>);
	}

	return (
		<div>
			<List>
				{members.map((m) => {
					const isSelf = m.user_id === me.user_id;
					// Admins can edit anyone except the owner and themselves.
					const editable = canManage && !isSelf && m.role !== 'owner';
					return (
						<ListRow key={m.user_id}>
							<InitialsAvatar name={m.name || m.email} />
							<div class="min-w-0 flex-1">
								<div class="flex items-baseline gap-2">
									<span class="truncate font-medium text-fg" title={m.name || m.email}>
										{m.name || m.email}
									</span>
									{isSelf && <span class="shrink-0 text-xs text-muted">You</span>}
								</div>
								{m.name && (
									<div class="truncate text-xs text-muted" title={m.email}>
										{m.email}
									</div>
								)}
							</div>
							{editable ? (
								<RoleSelect
									value={m.role}
									disabled={busy}
									onChange={(r) => {
										if (r !== m.role) run('set_member_role', { email: m.email, role: r });
									}}
								/>
							) : (
								<span
									class={`shrink-0 text-sm ${m.role === 'owner' ? 'text-fg' : 'text-muted'}`}
									title={m.role === 'owner' ? 'The owner role is fixed' : undefined}
								>
									{ROLE_LABEL[m.role]}
								</span>
							)}
							{editable && (
								<Button
									variant="ghost"
									size="icon"
									disabled={busy}
									title={`Remove ${m.email}`}
									aria-label={`Remove ${m.email}`}
									onClick={() => run('remove_member', { email: m.email })}
								>
									<CloseIcon />
								</Button>
							)}
						</ListRow>
					);
				})}
			</List>

			{invites.length > 0 && (
				<div class="mt-6">
					<div class={`mb-1.5 ${eyebrow}`}>Pending invites</div>
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
										Invited{inv.invited_at ? ` ${relativeTime(inv.invited_at)}` : ''}
									</div>
								</div>
								<span class="shrink-0 text-sm text-muted">{ROLE_LABEL[inv.role]}</span>
								{canManage && (
									<Button
										variant="ghost"
										size="icon"
										disabled={busy}
										title={`Revoke invite for ${inv.email}`}
										aria-label={`Revoke invite for ${inv.email}`}
										onClick={() => run('remove_member', { email: inv.email })}
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

export { MembersView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		members: { members: Member[]; invites: Invite[]; me: MemberSelf };
	}
}

export default defineView(
	'members',
	(v) => <MembersView members={v.members} invites={v.invites} me={v.me} />,
	{
		// Gated on the viewer's role here rather than inside the component: the actions
		// function gets the view's props, so a viewer never sees an Invite they cannot use.
		actions: (v) =>
			v.me.role === 'admin' || v.me.role === 'owner'
				? [
						{
							key: 'invite',
							label: 'Invite',
							title: 'Invite a member',
							onClick: openInviteMember
						}
					]
				: []
	}
);
