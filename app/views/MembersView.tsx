// ---------- members view ----------

import { useState } from 'preact/hooks';
import type { Member, Invite, MemberSelf, MemberRole } from '../core/types.ts';
import { callTool, firstText } from '../core/host.ts';
import { refreshMembers } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { relativeTime } from '../core/util.ts';
import { InitialsAvatar, CloseIcon } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';
import { addCtl } from '../core/store.ts';
import { Button, Input, Select, List, ListRow, AddRow, useAddAction } from '../ui/index.ts';
import { eyebrow } from '../ui/typography.ts';

const ROLE_LABEL: Record<MemberRole, string> = {
	viewer: 'Viewer',
	editor: 'Editor',
	admin: 'Admin',
	owner: 'Owner'
};
// The roles an admin can assign in the UI (owner is never offered — see members.ts).
const ASSIGNABLE_ROLES: MemberRole[] = ['viewer', 'editor', 'admin'];

// Org roster: who's in the org, their role, and pending invites. Any member sees
// the list; admins get inline role dropdowns, a remove control, and an invite box.
// Non-admins see plain role text — the presence/absence of controls IS the signal
// that you can manage (show, don't tell), so there's no explanatory copy.
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
	const [inviteEmail, setInviteEmail] = useState('');
	const [inviteRole, setInviteRole] = useState<MemberRole>('editor');
	const [inviting, setInviting] = useState(false);
	useAddAction(() => setInviting(true));

	// Run a member mutation, refresh the roster from its result, toast the outcome.
	async function run(tool: string, args: Record<string, unknown>, onOk?: () => void) {
		if (busy) return;
		setBusy(true);
		const res = await callTool(tool, args);
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		onOk?.();
		toast(firstText(res));
		refreshMembers((res.structuredContent ?? {}) as Record<string, unknown>);
	}

	return (
		<div>
			<List>
				{/* The composer opens where the invited person will land, rather than in a
				    permanently-docked form above a roster you are usually just reading. */}
				{canManage && (
					<AddRow open={inviting} onClose={() => setInviting(false)}>
						{({ close }) => (
							<form
								class="flex items-center gap-2"
								onSubmit={(e) => {
									e.preventDefault();
									const email = inviteEmail.trim();
									if (!email) return;
									run('invite_member', { email, role: inviteRole }, () => {
										setInviteEmail('');
										close();
									});
								}}
							>
								<Input
									// eslint-disable-next-line
									autofocus
									type="email"
									required
									value={inviteEmail}
									onInput={(e) => setInviteEmail((e.target as HTMLInputElement).value)}
									placeholder="name@example.com"
									class="min-w-0 flex-1"
								/>
								<RoleSelect value={inviteRole} disabled={busy} onChange={(r) => setInviteRole(r)} />
								<Button type="submit" disabled={busy || !inviteEmail.trim()}>
									Invite
								</Button>
							</form>
						)}
					</AddRow>
				)}
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

// Compact role picker used for both inviting and changing a role. Native <select>
// so it's keyboard/host accessible; styled to sit quietly in the row.
function RoleSelect({
	value,
	disabled,
	onChange
}: {
	value: MemberRole;
	disabled?: boolean;
	onChange: (r: MemberRole) => void;
}) {
	return (
		<Select
			value={value}
			disabled={disabled}
			aria-label="Role"
			onChange={(e) => onChange((e.target as HTMLSelectElement).value as MemberRole)}
			class="shrink-0 py-1 pl-2 pr-1"
		>
			{ASSIGNABLE_ROLES.map((r) => (
				<option key={r} value={r}>
					{ROLE_LABEL[r]}
				</option>
			))}
		</Select>
	);
}

export { MembersView, RoleSelect, ROLE_LABEL, ASSIGNABLE_ROLES };

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
			addCtl.bound && (v.me.role === 'admin' || v.me.role === 'owner')
				? [{ key: 'invite', label: 'Invite', title: 'Invite a member', onClick: addCtl.start }]
				: []
	}
);
