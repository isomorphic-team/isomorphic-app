import { useState } from 'preact/hooks';
import type { MemberRole } from '../core/types.ts';
import { callTool, firstText } from '../core/host.ts';
import { goBack } from '../core/store.ts';
import { openBrainAccess, finishShareBrain } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { BrainGlyph } from '../core/icons.tsx';
import { RoleSelect, BRAIN_ROLE_BLURB } from '../components/RoleSelect.tsx';
import { defineView } from '../core/view-registry.ts';
import { Button, Input, Flow } from '../ui/index.ts';

// Give one person access to one brain. Opened from the sharing panel's header action.
//
// The brain-scope twin of InviteMemberView, and deliberately the same screen at a
// different altitude: inviting adds someone to the ORGANIZATION, sharing lets someone
// already in it reach THIS brain. Two operations that are easy to confuse are worth
// making look alike, so the only thing that differs is what the title says they act on.
//
// `brainId` rides on every call because the panel can be opened for a brain that is
// not the active one (the Share control in the brains list), and a bare share_brain
// would then silently act on the wrong brain.
function ShareBrainView({ brainId, brainLabel }: { brainId: string; brainLabel: string }) {
	const [email, setEmail] = useState('');
	const [role, setRole] = useState<MemberRole>('editor');
	const [busy, setBusy] = useState(false);

	async function submit(e: Event) {
		e.preventDefault();
		const addr = email.trim();
		if (!addr || busy) return;
		setBusy(true);
		const res = await callTool('share_brain', { brain: brainId, email: addr, access: role });
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast(firstText(res));
		finishShareBrain((res.structuredContent ?? {}) as Record<string, unknown>);
	}

	return (
		<form onSubmit={submit}>
			<Flow
				icon={<BrainGlyph />}
				title={`Share ${brainLabel}`}
				// States the one guardrail people hit: sharing reaches org members only,
				// because a grant to anyone else resolves to nothing (see brain-access.ts).
				subtitle="They must already be a member of this organization. Invite them first if they are not."
				footer={
					<>
						<Button
							type="button"
							variant="outline"
							onClick={() => goBack(() => openBrainAccess(brainId))}
							disabled={busy}
							class="text-sm"
						>
							Cancel
						</Button>
						<Button type="submit" disabled={busy || !email.trim()} class="text-sm">
							{busy ? 'Sharing…' : 'Share'}
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
						<span class="block text-xs text-muted">Access level</span>
						<span class="block text-sm text-fg">{BRAIN_ROLE_BLURB[role]}</span>
					</span>
					<RoleSelect value={role} disabled={busy} onChange={setRole} />
				</div>
			</Flow>
		</form>
	);
}

export { ShareBrainView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		'share-brain': { brainId: string; brainLabel: string };
	}
}

export default defineView('share-brain', (v) => (
	<ShareBrainView brainId={v.brainId} brainLabel={v.brainLabel} />
));
