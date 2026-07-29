// ---------- connected accounts ----------

import { useState } from 'preact/hooks';
import type { ConnectedAccount } from '../core/types.ts';
import { callTool, firstText } from '../core/host.ts';
import { parseAccounts } from '../core/actions.ts';
import { toast, askConfirm } from '../core/toast.tsx';
import { InitialsAvatar, CloseIcon, GithubIcon } from '../core/icons.tsx';
import { Button, List, ListRow } from '../ui/index.ts';

// The person's linked identities, rendered inline in Your settings: email logins +
// GitHub accounts. Unlinking updates the list in place.
//
// Connecting is NOT here: it is a header action opening its own view
// (ConnectAccountView), because linking is two steps and the second one is a link the
// user has to go act on. See app/ui/Flow.tsx. Anyone can link another of THEIR own
// accounts (verified by signing in as it), so there is no admin gate on that action.
//
// Owns its `accounts` state (seeded from props) so unlink refreshes without rebuilding
// the whole settings view.
function ConnectedAccountsSection({ initial }: { initial: ConnectedAccount[] }) {
	const [accounts, setAccounts] = useState(initial);
	const [busy, setBusy] = useState(false);

	async function unlink(args: Record<string, unknown>, label: string) {
		if (busy) return;
		const ok = await askConfirm({
			title: 'Unlink account?',
			body: `${label} will no longer share your brains. You can reconnect it anytime.`,
			confirmLabel: 'Unlink'
		});
		if (!ok) return;
		setBusy(true);
		const res = await callTool('unlink_identity', args);
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast(firstText(res));
		setAccounts(parseAccounts((res.structuredContent ?? {}) as Record<string, unknown>));
	}

	// The signed-in identity is already shown as the card above, so omit it here.
	const emails = accounts.filter((a) => a.kind === 'email' && !a.is_self);
	const githubs = accounts.filter((a) => a.kind === 'github');

	return (
		<div>
			<List>
				{emails.map((a) => (
					<ListRow key={a.user_id}>
						<InitialsAvatar name={a.name || a.email || '?'} />
						<div class="min-w-0 flex-1">
							<div class="flex items-baseline gap-2">
								<span class="truncate font-medium text-fg" title={a.email}>
									{a.email}
								</span>
								{a.is_self && <span class="shrink-0 text-xs text-muted">This sign-in</span>}
							</div>
							{a.name && <div class="truncate text-xs text-muted">{a.name}</div>}
						</div>
						{!a.is_self && (
							<Button
								variant="ghost"
								size="icon"
								disabled={busy}
								title={`Unlink ${a.email}`}
								aria-label={`Unlink ${a.email}`}
								onClick={() => unlink({ email: a.email }, a.email ?? 'This account')}
							>
								<CloseIcon />
							</Button>
						)}
					</ListRow>
				))}
				{githubs.map((a) => (
					<ListRow key={`gh-${a.github_user_id}`}>
						<span
							class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-chip text-muted"
							aria-hidden="true"
						>
							<GithubIcon />
						</span>
						<div class="min-w-0 flex-1">
							<div class="truncate font-medium text-fg">@{a.github_login ?? a.github_user_id}</div>
							<div class="text-xs text-muted">GitHub</div>
						</div>
						<Button
							variant="ghost"
							size="icon"
							disabled={busy}
							title={`Unlink @${a.github_login ?? a.github_user_id}`}
							aria-label={`Unlink @${a.github_login ?? a.github_user_id}`}
							onClick={() =>
								unlink(
									{ github: String(a.github_login ?? a.github_user_id) },
									`@${a.github_login ?? a.github_user_id}`
								)
							}
						>
							<CloseIcon />
						</Button>
					</ListRow>
				))}
			</List>
		</div>
	);
}

export { ConnectedAccountsSection };
