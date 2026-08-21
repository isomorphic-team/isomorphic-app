import { useState } from 'preact/hooks';
import { callTool, firstText } from '../core/host.ts';
import { goBack } from '../core/store.ts';
import { openConnections, finishConnection } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { LinkIcon } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';
import { Button, Input, Flow, submitOnEnter } from '../ui/index.ts';

// Start a shared space with another organization. Pushed off the connections panel,
// like every other add-shaped action in the app (app/ui/Flow.tsx).
//
// ONE FIELD, and the reduction is the point. create_connection takes four arguments and
// three of them are answerable from where the person is standing:
//
//   the anchor  — the panel this was opened from is one brain's, so that brain is it.
//                 This is the argument that decides who on your side can reach the room
//                 and nothing re-anchors it later, so it is stated in a sentence the
//                 person reads rather than defaulted in a picker they click past.
//   the org     — the anchor brain's.
//   the name    — the counterparty's domain, which is what people call these anyway.
//                 A room with a second engagement behind it can be renamed by asking.
//
// What is left is the only thing the system cannot know: who is on the other side.
function StartConnectionView({ anchorLabel }: { anchorLabel: string }) {
	const [email, setEmail] = useState('');
	const [name, setName] = useState('');
	const [busy, setBusy] = useState(false);

	// "jane@northwind.com" → "Northwind". Not clever, and it does not need to be: it is
	// a starting point in a field the person can see and overwrite before submitting.
	const suggested = (() => {
		const domain = email.split('@')[1]?.split('.')[0] ?? '';
		return domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : '';
	})();
	const finalName = name.trim() || suggested;

	async function submit(e: Event) {
		e.preventDefault();
		const addr = email.trim();
		if (!addr || !finalName || busy) return;
		setBusy(true);
		const res = await callTool('create_connection', {
			name: finalName,
			with: addr,
			// EXPLICIT, never left to the default. The tool now refuses to guess an
			// anchor, and this screen knows the answer, so it says it.
			about: anchorLabel
		});
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast(firstText(res));
		void finishConnection();
	}

	return (
		<form onSubmit={submit}>
			<Flow
				icon={<LinkIcon />}
				title="Start a shared space"
				subtitle="One set of pages you and another organization both write in, owned by neither of you."
				footer={
					<>
						<Button
							type="button"
							variant="outline"
							onClick={() => goBack(openConnections)}
							disabled={busy}
							class="text-sm"
						>
							Cancel
						</Button>
						<Button
							type="button"
							onClick={submit}
							disabled={busy || !email.trim() || !finalName}
							class="text-sm"
						>
							{busy ? 'Starting…' : 'Start'}
						</Button>
					</>
				}
			>
				<label class="block">
					<span class="mb-1 block text-xs text-muted">Who are you working with?</span>
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
					<span class="mt-1 block text-xs text-muted">
						They do not need an account yet. The invitation waits for them.
					</span>
				</label>

				{/* Shown only once there is something to name, so the screen opens as one
				    field and grows a second rather than presenting two. The suggestion is
				    already in the box: this is a correction, not a decision. */}
				{suggested && (
					<label class="mt-3 block">
						<span class="mb-1 block text-xs text-muted">Call it</span>
						<Input
							onKeyDown={submitOnEnter(submit)}
							type="text"
							value={name || suggested}
							disabled={busy}
							onInput={(e) => setName((e.target as HTMLInputElement).value)}
							class="w-full bg-bg px-3 py-2"
						/>
						<span class="mt-1 block text-xs text-muted">Both sides see this name.</span>
					</label>
				)}

				{/* THE ACCESS SENTENCE. The anchor is not a field, so this is the only place
				    the person is told what they are deciding, and it is deliberately about
				    THIS screen rather than about connections in general. */}
				<p class="mt-4 border-t border-border pt-3 text-sm text-muted">
					Anyone who can open <span class="text-fg">{anchorLabel}</span> will be able to open the
					shared space. Nobody on their side gets access to {anchorLabel} itself.
				</p>
				{/* Nothing in this product sends mail, so the flow must not imply that it
				    does. Said before submitting rather than after, because it changes what
				    the person does next. */}
				<p class="mt-2 text-sm text-muted">No email is sent. Tell them yourself once it exists.</p>
			</Flow>
		</form>
	);
}

export { StartConnectionView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		'start-connection': { anchorLabel: string };
	}
}

export default defineView('start-connection', (v) => (
	<StartConnectionView anchorLabel={v.anchorLabel} />
));
