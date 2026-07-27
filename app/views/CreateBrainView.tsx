import { useState } from 'preact/hooks';
import { submitCreateBrain, openBrowse } from '../core/actions.ts';
import { BrainGlyph } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';

// Create-a-brain form + empty state. Shown when the user has no brain yet ("create your
// first brain") or picks "New brain" from the switcher. Scaffolds a fresh named brain and
// lands on it (see submitCreateBrain). Per-brain access is a later phase — a new brain is
// visible per the current org model (for a personal org, that's just you).
function CreateBrainView({ first }: { first: boolean }) {
	const [name, setName] = useState('');
	const [busy, setBusy] = useState(false);
	const submit = () => {
		if (!name.trim() || busy) return;
		setBusy(true);
		void submitCreateBrain(name);
	};
	return (
		<div class="mx-auto mt-16 max-w-sm px-4 text-center">
			<div class="mb-3 flex justify-center text-muted">
				<BrainGlyph />
			</div>
			<h2 class="text-base font-semibold text-fg">
				{first ? 'Create your first brain' : 'Create a new brain'}
			</h2>
			<p class="mx-auto mt-1 max-w-xs text-sm text-muted">
				{first
					? 'A brain is a knowledge base Claude reads and maintains for you. Name it to get started.'
					: 'Give your new knowledge base a name.'}
			</p>
			<input
				type="text"
				// eslint-disable-next-line
				autofocus
				value={name}
				placeholder="e.g. Personal, Project Atlas"
				disabled={busy}
				onInput={(e) => setName((e.target as HTMLInputElement).value)}
				onKeyDown={(e) => e.key === 'Enter' && submit()}
				class="mt-4 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
			/>
			<div class="mt-3 flex justify-center gap-2">
				{!first && (
					<button
						type="button"
						onClick={() => openBrowse()}
						disabled={busy}
						class="rounded-md border border-border px-3.5 py-1.5 text-[13px] text-fg hover:bg-chip"
					>
						Cancel
					</button>
				)}
				<button
					type="button"
					onClick={submit}
					disabled={busy || !name.trim()}
					class="rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
				>
					{busy ? 'Creating…' : 'Create brain'}
				</button>
			</div>
		</div>
	);
}

export { CreateBrainView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		'create-brain': { first: boolean };
	}
}

export default defineView('create-brain', (v) => <CreateBrainView first={v.first} />);
