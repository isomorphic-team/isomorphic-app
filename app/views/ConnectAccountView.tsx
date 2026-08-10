import { useState } from 'preact/hooks';
import { app, callTool, firstText } from '../core/host.ts';
import { goBack } from '../core/store.ts';
import { openSettings } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { LinkIcon } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';
import { Button, Input, Flow, FlowNote, submitOnEnter } from '../ui/index.ts';

// Link another of your own accounts. Opened from Your settings.
//
// Genuinely two steps — name the account, then go sign in as it — and step two
// REPLACES step one rather than appearing elsewhere. As an inline composer this was
// the worst of the three add flows: the form sat in the list while the verification
// link rendered as a banner above it, so submitting made the form vanish and the
// answer appear somewhere else on the screen.
function ConnectAccountView() {
	const [email, setEmail] = useState('');
	const [linkUrl, setLinkUrl] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(e: Event) {
		e.preventDefault();
		if (busy) return;
		setBusy(true);
		const addr = email.trim();
		const res = await callTool('link_identity', addr ? { email: addr } : {});
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		const sc = (res.structuredContent ?? {}) as { link?: { url?: string } };
		// A URL advances to step two. Anything else is a message, not a link to open.
		if (sc.link?.url) setLinkUrl(sc.link.url);
		else toast(firstText(res));
	}

	const leave = () => goBack(openSettings);

	// Step two. The roster is deliberately NOT refreshed on the way out: the account
	// isn't linked until they follow the link and sign in, so showing it as connected
	// here would be a lie the next load would take back.
	if (linkUrl)
		return (
			<Flow
				icon={<LinkIcon />}
				title="Almost there"
				subtitle="Open this link and sign in as the account you want to connect."
				footer={
					<Button variant="outline" onClick={leave} class="text-sm">
						Done
					</Button>
				}
			>
				<FlowNote>
					<Button
						variant="link"
						onClick={() => app.openLink({ url: linkUrl })}
						class="block break-all text-left"
					>
						{linkUrl}
					</Button>
					<div class="mt-1.5 text-xs text-muted">Expires in 1 hour · single use</div>
				</FlowNote>
			</Flow>
		);

	return (
		<form onSubmit={submit}>
			<Flow
				icon={<LinkIcon />}
				title="Connect an account"
				subtitle="Link another email you use, so its brains show up here too."
				footer={
					<>
						<Button type="button" variant="outline" onClick={leave} disabled={busy} class="text-sm">
							Cancel
						</Button>
						<Button type="button" onClick={submit} disabled={busy || !email.trim()} class="text-sm">
							{busy ? 'Preparing…' : 'Connect'}
						</Button>
					</>
				}
			>
				<label class="block">
					<span class="mb-1 block text-xs text-muted">Email address</span>
					<Input
						// eslint-disable-next-line
						autofocus
						onKeyDown={submitOnEnter(submit)}
						type="email"
						required
						value={email}
						disabled={busy}
						onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
						placeholder="name@example.com"
						class="w-full bg-bg px-3 py-2"
					/>
				</label>
			</Flow>
		</form>
	);
}

export { ConnectAccountView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		// No props: the flow's whole state is its own form state.
		'connect-account': Record<never, never>;
	}
}

export default defineView('connect-account', () => <ConnectAccountView />);
