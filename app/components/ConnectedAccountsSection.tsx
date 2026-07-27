// ---------- connected accounts view ----------

import { useState } from 'preact/hooks';
import type { ConnectedAccount } from '../core/types.ts';
import { app, callTool, firstText } from '../core/host.ts';
import { parseAccounts } from '../core/actions.ts';
import { toast, askConfirm } from '../core/toast.tsx';
import { InitialsAvatar, CloseIcon, GithubIcon } from '../core/icons.tsx';

// The person's linked identities, rendered inline in Your settings: email logins +
// GitHub accounts. Anyone can link another of THEIR own accounts (verified by signing
// in as it), so there's no admin gate. Linking returns a verification URL (not a
// roster), surfaced as a callout the user opens; unlinking updates the list in place.
// Owns its `accounts` state (seeded from props) so unlink refreshes without rebuilding
// the whole settings view.
function ConnectedAccountsSection({ initial }: { initial: ConnectedAccount[] }) {
	const [accounts, setAccounts] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [email, setEmail] = useState('');
	const [linkUrl, setLinkUrl] = useState<string | null>(null);

	async function startLink() {
		if (busy) return;
		setBusy(true);
		const res = await callTool('link_identity', email.trim() ? { email: email.trim() } : {});
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		const sc = (res.structuredContent ?? {}) as { link?: { url?: string } };
		if (sc.link?.url) {
			setLinkUrl(sc.link.url);
			setEmail('');
		} else {
			toast(firstText(res));
		}
	}

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
			<form
				class="mb-3 flex items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					startLink();
				}}
			>
				<input
					type="email"
					value={email}
					onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
					placeholder="Connect another email"
					class="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
				/>
				<button
					type="submit"
					disabled={busy}
					class="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
				>
					Connect
				</button>
			</form>

			{linkUrl && (
				<div class="mb-4 rounded-md border border-border bg-chip px-3 py-2.5 text-sm">
					<div class="text-fg">Open this link and sign in as the account you want to connect:</div>
					<button
						type="button"
						onClick={() => app.openLink({ url: linkUrl })}
						class="mt-1 break-all text-left text-accent hover:underline"
					>
						{linkUrl}
					</button>
					<div class="mt-1 text-xs text-muted">Expires in 1 hour · single use</div>
				</div>
			)}

			<ul class="flex flex-col">
				{emails.map((a) => (
					<li
						key={a.user_id}
						class="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0"
					>
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
							<button
								type="button"
								disabled={busy}
								title={`Unlink ${a.email}`}
								onClick={() => unlink({ email: a.email }, a.email ?? 'This account')}
								class="shrink-0 rounded p-1 text-muted transition-colors hover:bg-chip hover:text-fg disabled:opacity-50"
							>
								<CloseIcon />
							</button>
						)}
					</li>
				))}
				{githubs.map((a) => (
					<li
						key={`gh-${a.github_user_id}`}
						class="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0"
					>
						<span
							class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-chip text-muted"
							aria-hidden="true"
						>
							<GithubIcon />
						</span>
						<div class="min-w-0 flex-1">
							<div class="truncate font-medium text-fg">@{a.github_login ?? a.github_user_id}</div>
							<div class="text-xs text-muted">GitHub</div>
						</div>
						<button
							type="button"
							disabled={busy}
							title={`Unlink @${a.github_login ?? a.github_user_id}`}
							onClick={() =>
								unlink(
									{ github: String(a.github_login ?? a.github_user_id) },
									`@${a.github_login ?? a.github_user_id}`
								)
							}
							class="shrink-0 rounded p-1 text-muted transition-colors hover:bg-chip hover:text-fg disabled:opacity-50"
						>
							<CloseIcon />
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

export { ConnectedAccountsSection };
