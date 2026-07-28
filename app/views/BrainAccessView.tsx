// ---------- brain access (sharing) view ----------

import { useState } from 'preact/hooks';
import type { BrainAccessEntry, BrainAccessSelf, MemberRole } from '../core/types.ts';
import { callTool, firstText } from '../core/host.ts';
import { refreshBrainAccess } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { InitialsAvatar, CloseIcon } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';
import { RoleSelect, ROLE_LABEL } from '../components/RoleSelect.tsx';

// Per-brain sharing: who can reach THIS brain, at what level, and whether it's
// private or open to the whole organization. The brain-scope sibling of
// MembersView (which is the org roster), same shape, one scope down, so the two
// read as the same surface at different altitudes.
//
// Only brain admins get controls. Everyone else sees the list plainly, and the
// absence of controls is the signal that they can't manage it (show, don't tell).
function BrainAccessView({
	access,
	visibility,
	brainLabel,
	me
}: {
	access: BrainAccessEntry[];
	visibility: string;
	brainLabel: string;
	me: BrainAccessSelf;
}) {
	// Gated on the BRAIN role, not the org role: an org admin has it via the
	// floor, a creator via their own grant, and someone shared in as editor
	// deliberately does not.
	const canManage = me.role === 'admin' || me.role === 'owner';
	const isPrivate = visibility === 'private';
	const [busy, setBusy] = useState(false);
	const [shareEmail, setShareEmail] = useState('');
	const [shareRole, setShareRole] = useState<MemberRole>('editor');

	async function run(args: Record<string, unknown>, onOk?: () => void) {
		if (busy) return;
		setBusy(true);
		const res = await callTool('share_brain', args);
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		onOk?.();
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
					<button
						type="button"
						disabled={busy}
						onClick={() => run({ visibility: isPrivate ? 'org' : 'private' })}
						class="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-fg transition-colors hover:bg-chip disabled:opacity-50"
					>
						{isPrivate ? 'Share with organization' : 'Make private'}
					</button>
				)}
			</div>

			{canManage && (
				<form
					class="mb-4 flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						const email = shareEmail.trim();
						if (!email) return;
						run({ email, access: shareRole }, () => setShareEmail(''));
					}}
				>
					<input
						type="email"
						required
						value={shareEmail}
						onInput={(e) => setShareEmail((e.target as HTMLInputElement).value)}
						placeholder="Share with email"
						class="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
					/>
					<RoleSelect value={shareRole} disabled={busy} onChange={(r) => setShareRole(r)} />
					<button
						type="submit"
						disabled={busy || !shareEmail.trim()}
						class="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
					>
						Share
					</button>
				</form>
			)}

			<ul class="flex flex-col">
				{access.map((a) => {
					const isSelf = a.user_id === me.user_id;
					// Only an explicit share can be edited or revoked. Access inherited
					// from org visibility or the org-admin floor has no row to change;
					// offering a control that silently does nothing is worse than none.
					const editable = canManage && !isSelf && a.via === 'grant';
					return (
						<li
							key={a.user_id}
							class="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0"
						>
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
								<button
									type="button"
									disabled={busy}
									title={`Remove ${a.email}'s access`}
									onClick={() => run({ email: a.email, access: 'none' })}
									class="shrink-0 rounded p-1 text-muted transition-colors hover:bg-chip hover:text-fg disabled:opacity-50"
								>
									<CloseIcon />
								</button>
							)}
						</li>
					);
				})}
			</ul>

			{access.length === 0 && (
				<div class="py-6 text-center text-sm text-muted">Nobody else has access yet.</div>
			)}
		</div>
	);
}

export { BrainAccessView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		'brain-access': {
			access: BrainAccessEntry[];
			visibility: string;
			brainLabel: string;
			me: BrainAccessSelf;
		};
	}
}

export default defineView('brain-access', (v) => (
	<BrainAccessView
		access={v.access}
		visibility={v.visibility}
		brainLabel={v.brainLabel}
		me={v.me}
	/>
));
