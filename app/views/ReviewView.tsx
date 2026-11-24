import { useState } from 'preact/hooks';
import type { OpenListWire, OpenRowWire, ReviewPolicy, ReviewPolicyPage } from '../core/types.ts';
import { navigateTo, runBaselineScan } from '../core/actions.ts';
import { defineView } from '../core/view-registry.ts';
import { DETECTION_LABELS, type DetectionKind } from '../../src/lib/policy-detectors.ts';
import { Button, List, ListRow, listRowTitle } from '../ui/index.ts';
import { eyebrow, viewTitle } from '../ui/typography.ts';

function kindsLine(p: ReviewPolicyPage): string {
	return p.kinds
		.map((k) => {
			const label = DETECTION_LABELS[k.kind as DetectionKind] ?? k.kind;
			return k.count > 1 ? `${label} ×${k.count}` : label;
		})
		.join(' · ');
}

// The open list: what is due, what needs attention, other dates and the one feature offer,
// the same assembly `validate` prints. Read-only: answering a finding is `resolve`.
const OPEN_SECTIONS: { key: keyof Omit<OpenListWire, 'offer'>; label: string }[] = [
	{ key: 'due', label: 'Due' },
	{ key: 'coming', label: 'Coming due' },
	{ key: 'findings', label: 'Needs attention' },
	{ key: 'otherDates', label: 'Other dates' }
];

function OpenRows({ label, rows }: { label: string; rows: OpenRowWire[] }) {
	if (rows.length === 0) return null;
	return (
		<div class="mb-4">
			<div class={`mb-1 ${eyebrow}`}>{label}</div>
			<List>
				{rows.map((r) => (
					<ListRow key={r.key}>
						<div class="min-w-0 flex-1 whitespace-pre-line text-sm text-fg">{r.headline}</div>
					</ListRow>
				))}
			</List>
		</div>
	);
}

function OpenList({ open }: { open: OpenListWire }) {
	const empty = OPEN_SECTIONS.every((s) => open[s.key].length === 0) && !open.offer;
	return (
		<div class="mb-6">
			<h2 class={`mb-3 ${viewTitle}`}>What validate found</h2>
			{empty ? <div class="text-sm text-muted">Nothing is open.</div> : null}
			{OPEN_SECTIONS.map((s) => (
				<OpenRows key={s.key} label={s.label} rows={open[s.key]} />
			))}
			{open.offer ? <OpenRows label="Suggestion" rows={[open.offer]} /> : null}
		</div>
	);
}

// The data-policy guard's record for this brain. Brain admins only: a path and a kind
// already say where sensitive data sits.
const SCAN_LABEL = {
	none: 'Scan existing content',
	running: 'Continue scan',
	done: 'Scan again'
};

function PolicyBlock({ policy }: { policy: ReviewPolicy }) {
	const [progress, setProgress] = useState<string | null>(null);
	const { baseline, text } = policy.coverage;
	const scan = async () => {
		setProgress('Scanning…');
		try {
			await runBaselineScan((files) => setProgress(`Scanning… ${files} files so far`));
		} catch (e) {
			setProgress(`The scan stopped: ${String(e)}`);
		}
	};
	const scanning = progress?.startsWith('Scanning') ?? false;
	return (
		<div>
			<h2 class={`mb-3 ${viewTitle}`}>Sensitive data</h2>
			{policy.mode === 'off' ? (
				<div class="mb-3 text-sm text-muted">Checks are off for this brain</div>
			) : null}
			<div class="mb-3 text-sm text-muted">{text}</div>
			{policy.mode === 'off' ? null : (
				<div class="mb-4 flex items-center gap-3">
					<Button disabled={scanning} onClick={scan}>
						{SCAN_LABEL[baseline]}
					</Button>
					{progress ? <span class="text-sm text-muted">{progress}</span> : null}
				</div>
			)}
			{policy.pages.length === 0 ? (
				<div class="mt-16 text-center text-muted">Nothing open.</div>
			) : (
				<List>
					{policy.pages.map((p) => (
						<ListRow key={p.path}>
							<div class="min-w-0 flex-1">
								{/* A baseline scan also reports files that are not pages, which have no view. */}
								{p.path.endsWith('.md') ? (
									<button
										type="button"
										onClick={() => navigateTo(p.path)}
										title={p.path}
										class={`block max-w-full border-none bg-transparent p-0 text-left ${listRowTitle}`}
									>
										{p.path}
									</button>
								) : (
									<div title={p.path} class={`max-w-full ${listRowTitle}`}>
										{p.path}
									</div>
								)}
								<div class="mt-0.5 truncate text-xs text-muted">{kindsLine(p)}</div>
							</div>
						</ListRow>
					))}
				</List>
			)}
		</div>
	);
}

function ReviewView({ open, policy }: { open: OpenListWire; policy?: ReviewPolicy }) {
	return (
		<div>
			<OpenList open={open} />
			{policy ? <PolicyBlock policy={policy} /> : null}
		</div>
	);
}

export { ReviewView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		review: { open: OpenListWire; policy?: ReviewPolicy };
	}
}

export default defineView('review', (v) => <ReviewView open={v.open} policy={v.policy} />);
