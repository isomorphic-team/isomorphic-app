import type { ReviewPolicy, ReviewPolicyPage } from '../core/types.ts';
import { navigateTo } from '../core/actions.ts';
import { defineView } from '../core/view-registry.ts';
import { DETECTION_LABELS, type DetectionKind } from '../../src/lib/policy-detectors.ts';
import { List, ListRow, listRowTitle } from '../ui/index.ts';

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
function ReviewView({ policy }: { policy: ReviewPolicy }) {
	if (policy.mode === 'off' && policy.pages.length === 0)
		return (
			<div class="mt-16 text-center text-sm text-muted">
				The data-policy guard is off. Turn it on with{' '}
				<code class="text-fg">
					"review": {'{'} "policy": {'{'} "mode": "shadow" {'}'} {'}'}
				</code>{' '}
				in <code class="text-fg">.isomorphic.json</code>.
			</div>
		);
	return (
		<div>
			<div class="mb-3 text-sm text-muted">
				{policy.mode === 'shadow' ? 'Shadow mode' : 'Off'} · last {policy.windowDays} days
			</div>
			{policy.pages.length === 0 ? (
				<div class="mt-16 text-center text-muted">Nothing flagged.</div>
			) : (
				<List>
					{policy.pages.map((p) => (
						<ListRow key={p.path}>
							<div class="min-w-0 flex-1">
								<button
									type="button"
									onClick={() => navigateTo(p.path)}
									title={p.path}
									class={`block max-w-full border-none bg-transparent p-0 text-left ${listRowTitle}`}
								>
									{p.path}
								</button>
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
