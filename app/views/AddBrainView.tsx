import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { OrgTarget, ConnectableRepo } from '../core/types.ts';
import { callTool, firstText } from '../core/host.ts';
import { goBack } from '../core/store.ts';
import { openBrains, submitCreateBrain, finishAddBrain } from '../core/actions.ts';
import { toast } from '../core/toast.tsx';
import { BrainGlyph, GithubIcon, PlusIcon } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';
import { Button, Input, List, Flow, FlowNote } from '../ui/index.ts';

// Add a brain — the ONE way a brain joins this workspace, by either of its two
// sources:
//
//   * CREATE a new one. We scaffold a fresh repo and land in it.
//   * CONNECT a repo you already have. Pick the org, then the repo; contents stay.
//
// These used to be two separate screens with two separate vocabularies ("New brain"
// in the switcher, "Add a brain" on the brains list), reached from different controls,
// with nothing saying they were alternatives to the same intent — so wanting a second
// brain meant already knowing which noun we had filed your case under. Now there is
// one intent, one entry point, and the source is the flow's first step, asked only
// when both are actually available.
//
// Whole VIEW rather than an inline composer, like every add-shaped action: see
// app/ui/Flow.tsx.
type Source = 'create' | 'connect';

function AddBrainView({ orgs, first }: { orgs: OrgTarget[]; first: boolean }) {
	// Connecting needs an org you admin. The list comes from the server (the `brains`
	// payload), so an org holding no brains yet is offered like any other. It used to
	// be derived from the brains list, which could not name one. Creating is always
	// available, including when there is no org to connect into.
	const canConnect = orgs.length > 0;
	const canChoose = canConnect && !first;
	// One admin org means there is nothing to choose — open straight on its repos.
	const soleOrg = orgs.length === 1 ? orgs[0] : null;

	const [source, setSource] = useState<Source | null>(canChoose ? null : 'create');
	const [name, setName] = useState('');
	const [target, setTarget] = useState<OrgTarget | null>(null);
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
		void callTool('connect_brain', { org: target.orgId }).then((res) => {
			if (!live) return;
			if (res.isError) return setError(firstText(res));
			const sc = (res.structuredContent ?? {}) as { repos?: ConnectableRepo[] };
			setRepos(sc.repos ?? []);
		});
		return () => {
			live = false;
		};
	}, [target?.orgId, attempt]);

	function chooseSource(s: Source) {
		setSource(s);
		if (s === 'connect') setTarget(soleOrg);
	}

	function create(e: Event) {
		e.preventDefault();
		if (!name.trim() || busy) return;
		setBusy(true);
		void submitCreateBrain(name);
	}

	async function adopt(repo: ConnectableRepo) {
		if (busy || !target) return;
		setBusy(true);
		const res = await callTool('connect_brain', { repo: repo.id, org: target.orgId });
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast(firstText(res));
		const sc = (res.structuredContent ?? {}) as Record<string, unknown>;
		// Land in the new brain (its file tree surfaces Set-up if it needs configuring).
		if (typeof sc.connectedId === 'string') return finishAddBrain(sc, sc.connectedId);
		openBrains();
	}

	// ONE control, walking back exactly the steps that were actually shown: repo →
	// org → source → out. A step the flow skipped (a sole org, no choice of source)
	// is skipped on the way back too, so Back never lands somewhere the user has not
	// been. Labelled Cancel only when the next press leaves the flow.
	const atRepos = source === 'connect' && target !== null && orgs.length > 1;
	const atSource = source !== null && canChoose;
	const leaving = !atRepos && !atSource;
	function back() {
		if (atRepos) return setTarget(null);
		if (atSource) {
			setSource(null);
			setTarget(null);
			return;
		}
		goBack(openBrains);
	}

	const cancel = (
		<Button type="button" variant="outline" onClick={back} disabled={busy} class="text-sm">
			{leaving ? 'Cancel' : 'Back'}
		</Button>
	);

	// ---- choose a source ----
	if (source === null)
		return (
			<Flow
				icon={<BrainGlyph />}
				title="Add a brain"
				subtitle="Start something new, or bring in a repo you already have."
				footer={cancel}
			>
				<List class="rounded-md border border-border p-1">
					<PickRow
						icon={<PlusIcon />}
						label="Create a new brain"
						hint="We make the repo and set it up."
						onClick={() => chooseSource('create')}
					/>
					<PickRow
						icon={<GithubIcon />}
						label="Connect an existing repo"
						hint="Adopt a repo you already have. Its contents stay as they are."
						onClick={() => chooseSource('connect')}
					/>
				</List>
			</Flow>
		);

	// ---- create a new one ----
	if (source === 'create')
		return (
			<form onSubmit={create}>
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
							{/* On the very first brain there is nothing to go back to and no
							    alternative source, so the only button is the affirmative one. */}
							{!first && cancel}
							<Button type="submit" disabled={busy || !name.trim()} class="text-sm">
								{busy ? 'Creating…' : 'Create brain'}
							</Button>
						</>
					}
				>
					<label class="block">
						<span class="mb-1 block text-xs text-muted">Name</span>
						<Input
							type="text"
							// eslint-disable-next-line
							autofocus
							value={name}
							placeholder="e.g. Personal, Project Atlas"
							disabled={busy}
							onInput={(e) => setName((e.target as HTMLInputElement).value)}
							class="w-full bg-bg px-3 py-2"
						/>
					</label>
				</Flow>
			</form>
		);

	// ---- connect an existing repo: org, then repo ----
	return (
		<Flow
			icon={<GithubIcon />}
			title="Connect a repo"
			subtitle={
				target
					? `Choose a repo in ${target.orgLabel}. Its contents stay where they are.`
					: 'Choose where the brain belongs.'
			}
			footer={cancel}
		>
			{!target ? (
				<List class="rounded-md border border-border p-1">
					{orgs.map((o) => (
						<PickRow
							key={o.orgId}
							icon={<BrainGlyph />}
							label={o.orgLabel}
							onClick={() => setTarget(o)}
						/>
					))}
				</List>
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
					No unconnected repos in {target.orgLabel}. Add the repo to the Isomorphic App installation
					on GitHub first, then come back.
				</FlowNote>
			) : (
				<List class="rounded-md border border-border p-1">
					{repos.map((r) => (
						<PickRow
							key={r.id}
							icon={<GithubIcon />}
							label={r.id}
							disabled={busy}
							onClick={() => adopt(r)}
						/>
					))}
				</List>
			)}
		</Flow>
	);
}

// One option in a flow's picker. The WHOLE ROW is the button (variant `row` exists
// for exactly this) rather than a link-styled label inside a ListRow, which is what
// caused the vertical misalignment: an unsized inline <span> around a 15px glyph is
// as tall as a line box, so centring the box left the glyph sitting above the text
// beside it, and the label inherited the button base's `justify-center`.
function PickRow({
	icon,
	label,
	hint,
	disabled,
	onClick
}: {
	icon: VNode;
	label: string;
	hint?: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<li>
			<Button
				variant="row"
				disabled={disabled}
				onClick={onClick}
				class={`px-2 py-1.5 ${hint ? 'items-start' : 'items-center'}`}
			>
				<span
					class="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-muted"
					aria-hidden="true"
				>
					{icon}
				</span>
				<span class="min-w-0 flex-1">
					<span class="block truncate">{label}</span>
					{hint && <span class="mt-0.5 block text-xs text-muted">{hint}</span>}
				</span>
			</Button>
		</li>
	);
}

export { AddBrainView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		'add-brain': { orgs: OrgTarget[]; first: boolean };
	}
}

export default defineView('add-brain', (v) => <AddBrainView orgs={v.orgs} first={v.first} />);
