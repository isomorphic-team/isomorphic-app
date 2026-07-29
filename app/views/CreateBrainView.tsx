import { useState } from 'preact/hooks';
import { submitCreateBrain, openBrowse } from '../core/actions.ts';
import { goBack } from '../core/store.ts';
import { BrainGlyph } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';
import { Button, Input, Flow } from '../ui/index.ts';

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
		<Flow
			icon={<BrainGlyph />}
			title={first ? 'Create your first brain' : 'Create a new brain'}
			subtitle={
				first
					? 'A brain is a knowledge base Claude reads and maintains for you. Name it to get started.'
					: 'Give your new knowledge base a name.'
			}
			footer={
				<>
					{!first && (
						// Back to whatever opened this (the brains list, the switcher's "New
						// brain"), falling back to the file tree only when there is no history.
						// This used to always call openBrowse(), so cancelling out of the form
						// landed you somewhere you had never been.
						<Button
							variant="outline"
							onClick={() => goBack(() => openBrowse())}
							disabled={busy}
							class="text-sm"
						>
							Cancel
						</Button>
					)}
					<Button onClick={submit} disabled={busy || !name.trim()} class="text-sm">
						{busy ? 'Creating…' : 'Create brain'}
					</Button>
				</>
			}
		>
			<Input
				type="text"
				// eslint-disable-next-line
				autofocus
				value={name}
				placeholder="e.g. Personal, Project Atlas"
				disabled={busy}
				onInput={(e) => setName((e.target as HTMLInputElement).value)}
				onKeyDown={(e) => e.key === 'Enter' && submit()}
				class="w-full bg-bg px-3 py-2"
			/>
		</Flow>
	);
}

export { CreateBrainView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		'create-brain': { first: boolean };
	}
}

export default defineView('create-brain', (v) => <CreateBrainView first={v.first} />);
