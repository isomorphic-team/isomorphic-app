import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { OrgTarget, ConnectableRepo } from '../core/types.ts';
import { callTool, firstText } from '../core/host.ts';
import { goBack } from '../core/store.ts';
import { openBrains, finishAddBrain } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { BrainGlyph } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';
import { Button, List, ListRow, listRowTitle, Flow, FlowNote } from '../ui/index.ts';

// Adopt an existing GitHub repo as a brain: pick the org, then pick the repo.
//
// A whole VIEW rather than the inline composer its sibling actions use, because it
// picks from two lists whose lengths we don't control. The card is already a bounded
// box in the conversation, so the thing that plays a dialog's role here is a pushed
// view, not an overlay — see app/ui/Flow.tsx for the rule and CreateBrainView for
// the other half of the pair (this adopts a repo; that scaffolds a new one).
//
// The step lives in component state rather than in the View object: it is form state,
// exactly like the name field in CreateBrainView, and putting it in the store would
// make each step a separate history entry that Back would have to walk one at a time.
// Back inside the flow is the view's own business; Back OUT of it is goBack().
function AddBrainView({ orgs }: { orgs: OrgTarget[] }) {
	// One admin org means there is nothing to choose — open on step 2.
	const soleOrg = orgs.length === 1 ? orgs[0] : null;
	const [target, setTarget] = useState<OrgTarget | null>(soleOrg);
	const [repos, setRepos] = useState<ConnectableRepo[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Bumped by Try again. The org id alone can't drive a retry — it hasn't changed,
	// which is the whole reason the user is asking for the same fetch a second time.
	const [attempt, setAttempt] = useState(0);

	// Load the chosen org's connectable repos. Keyed on the org so re-picking refetches.
	useEffect(() => {
		if (!target) return;
		let live = true;
		setRepos(null);
		setError(null);
		// No `repo` arg → connect_brain returns the connectable candidates instead of adopting.
		void callTool('connect_brain', { brain: target.brainId }).then((res) => {
			if (!live) return;
			if (res.isError) return setError(firstText(res));
			const sc = (res.structuredContent ?? {}) as { repos?: ConnectableRepo[] };
			setRepos(sc.repos ?? []);
		});
		return () => {
			live = false;
		};
	}, [target?.brainId, attempt]);

	async function adopt(repo: ConnectableRepo) {
		if (busy || !target) return;
		setBusy(true);
		const res = await callTool('connect_brain', { repo: repo.id, brain: target.brainId });
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast(firstText(res));
		const sc = (res.structuredContent ?? {}) as Record<string, unknown>;
		// Land in the new brain (its file tree surfaces Set-up if it needs configuring).
		if (typeof sc.connectedId === 'string') return finishAddBrain(sc, sc.connectedId);
		openBrains();
	}

	// Back steps WITHIN the flow while there is a step to go back to, and out of it
	// otherwise — one control, so there is never a Back and a Cancel side by side
	// asking the user which kind of leaving they meant.
	const canStepBack = target !== null && orgs.length > 1;
	const leave = () => (canStepBack ? setTarget(null) : goBack(openBrains));

	return (
		<Flow
			icon={<BrainGlyph />}
			title="Add a brain"
			subtitle={
				target
					? `Choose a repo in ${target.orgLabel}. Its contents stay where they are.`
					: 'Connect a GitHub repo you already have. Choose where it belongs.'
			}
			footer={
				<Button variant="outline" onClick={leave} disabled={busy} class="text-sm">
					{canStepBack ? 'Back' : 'Cancel'}
				</Button>
			}
		>
			<>
				{!target ? (
					<PickList>
						{orgs.map((o) => (
							<PickRow key={o.orgId} label={o.orgLabel} onClick={() => setTarget(o)} />
						))}
					</PickList>
				) : error ? (
					<FlowNote>
						{error}{' '}
						<Button variant="link" onClick={() => setAttempt((n) => n + 1)}>
							Try again
						</Button>
					</FlowNote>
				) : repos === null ? (
					<FlowNote>Loading repos…</FlowNote>
				) : repos.length === 0 ? (
					<FlowNote>
						No unconnected repos in {target.orgLabel}. Add the repo to the Isomorphic App
						installation on GitHub first, then come back.
					</FlowNote>
				) : (
					<PickList>
						{repos.map((r) => (
							<PickRow key={r.id} label={r.id} disabled={busy} onClick={() => adopt(r)} />
						))}
					</PickList>
				)}
			</>
		</Flow>
	);
}

// The pickers are bordered because they ARE the choice on this screen — unlike a
// list screen's rows, which are content you are reading past.
function PickList({ children }: { children: ComponentChildren }) {
	return <List class="rounded-md border border-border px-1.5 py-1">{children}</List>;
}

function PickRow({
	label,
	disabled,
	onClick
}: {
	label: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<ListRow>
			<span class="shrink-0 text-muted">
				<BrainGlyph />
			</span>
			<Button variant="link" disabled={disabled} onClick={onClick} class={listRowTitle}>
				{label}
			</Button>
		</ListRow>
	);
}

export { AddBrainView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		'add-brain': { orgs: OrgTarget[] };
	}
}

export default defineView('add-brain', (v) => <AddBrainView orgs={v.orgs} />);
