import { useState } from 'preact/hooks';
import type { ReviewPolicy, ReviewPolicyPage } from '../core/types.ts';
import { navigateTo, runBaselineScan } from '../core/actions.ts';
import { defineView } from '../core/view-registry.ts';
import { DETECTION_LABELS, type DetectionKind } from '../../src/lib/policy-detectors.ts';
import { Button, List, ListRow, listRowTitle } from '../ui/index.ts';

function kindsLine(p: ReviewPolicyPage): string {
	return p.kinds
		.map((k) => {
			const label = DETECTION_LABELS[k.kind as DetectionKind] ?? k.kind;
			return k.count > 1 ? `${label} ×${k.count}` : label;
		})
		.join(' · ');
}

// The data-policy guard's record for this brain. Admin-only: a path and a kind already
// say where sensitive data sits.
const SCAN_LABEL = {
	none: 'Scan existing content',
	running: 'Continue scan',
	done: 'Scan again'
};

function ReviewView({ policy }: { policy: ReviewPolicy }) {
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

export { ReviewView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		review: { policy: ReviewPolicy };
	}
}

export default defineView('review', (v) => <ReviewView policy={v.policy} />);
