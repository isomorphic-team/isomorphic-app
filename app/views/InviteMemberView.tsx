import { useState } from 'preact/hooks';
import type { MemberRole } from '../core/types.ts';
import { callTool, firstText } from '../core/host.ts';
import { goBack } from '../core/store.ts';
import { openMembers, finishInvite } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { PeopleIcon } from '../core/icons.tsx';
import { RoleSelect, ROLE_BLURB } from '../components/RoleSelect.tsx';
import { defineView } from '../core/view-registry.ts';
import { Button, Input, Flow } from '../ui/index.ts';

// Invite someone to the org. Opened from the Members screen's header action.
//
// This is a one-commit form that would fit an inline row, and it used to be one. It
// is a pushed view because every add-shaped action in the app is (see app/ui/Flow.tsx)
// — three screens agreeing on where an add happens is worth more than each being
// individually optimal. It also buys room for a labelled field and a line saying what
// the chosen role can actually do, neither of which fits on a single list row.
function InviteMemberView() {
	const [email, setEmail] = useState('');
	const [role, setRole] = useState<MemberRole>('editor');
	const [busy, setBusy] = useState(false);

	async function submit(e: Event) {
		e.preventDefault();
		const addr = email.trim();
		if (!addr || busy) return;
		setBusy(true);
		const res = await callTool('invite_member', { email: addr, role });
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast(firstText(res));
		// Back to the roster, with the new invite already under Pending invites.
		finishInvite((res.structuredContent ?? {}) as Record<string, unknown>);
	}

	return (
		<form onSubmit={submit}>
			<Flow
				icon={<PeopleIcon />}
				title="Invite a member"
				subtitle="They get an email link. Signing in through it joins them to this organization."
				footer={
					<>
						<Button
							type="button"
							variant="outline"
							onClick={() => goBack(openMembers)}
							disabled={busy}
							class="text-sm"
						>
							Cancel
						</Button>
						<Button type="submit" disabled={busy || !email.trim()} class="text-sm">
							{busy ? 'Sending…' : 'Send invite'}
						</Button>
					</>
				}
			>
				<label class="block">
					<span class="mb-1 block text-xs text-muted">Email address</span>
					<Input
						// eslint-disable-next-line
						autofocus
						type="email"
						required
						value={email}
						disabled={busy}
						onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
						placeholder="name@example.com"
						class="w-full bg-bg px-3 py-2"
					/>
				</label>
				<div class="mt-3 flex items-center justify-between gap-3">
					<span class="min-w-0">
						<span class="block text-xs text-muted">Role</span>
						{/* The blurb is why this is a screen and not a row: on the roster the
						    same picker has to stand on its label alone. */}
						<span class="block text-sm text-fg">{ROLE_BLURB[role]}</span>
					</span>
					<RoleSelect value={role} disabled={busy} onChange={setRole} />
				</div>
			</Flow>
		</form>
	);
}

export { InviteMemberView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		// No props: the flow's whole state is its own form state.
		'invite-member': Record<never, never>;
	}
}

export default defineView('invite-member', () => <InviteMemberView />);
