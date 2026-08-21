import { useEffect, useState } from 'preact/hooks';
import { defineView } from '../core/view-registry.ts';
import { activeBrain, brainList, browseCache } from '../core/store.ts';
import { loadingLines, type LoadingTask, type LoadingFacts } from '../../src/lib/loading-lines.ts';

// The one place a wait is drawn. Every `{ kind: 'loading' }` in the app lands here, so
// a phrase set is chosen per task rather than per call site (see src/lib/loading-lines.ts,
// which is the pure half and the tested one).
//
// The caller's own label goes up FIRST and unchanged, and the rotation only starts
// after it has had its turn: a load that resolves quickly reads exactly as it did
// before this existed, and the personality is spent only on waits long enough to feel
// like waits.

// How long the literal label holds before the first swap, and the cadence after it.
// Long enough to read twice. A line that changes faster than you finish it is a
// flicker, not a status.
const FIRST_SWAP_MS = 2400;
const ROTATE_MS = 2800;

// What the widget already knows, at the moment the wait starts. All of it is local
// state the app fetched for other reasons; nothing here costs a round trip, which is
// the whole constraint: the alternative to a wait cannot be a second wait.
function facts(subject?: string): LoadingFacts {
	const brain = activeBrain ?? undefined;
	const row = brain ? brainList?.find((b) => b.id === brain.id) : undefined;
	return {
		brain: brain?.label,
		org: row?.orgLabel,
		subject,
		// The cached tree of the brain we are in. Absent on a cold open, which is
		// exactly when a page count would be a guess.
		pages: browseCache?.paths.length
	};
}

function LoadingView({
	label,
	task = 'generic',
	subject
}: {
	label: string;
	task?: LoadingTask;
	subject?: string;
}) {
	// The whole sequence is decided once, on mount: the facts cannot change while this
	// view is up (the next result replaces it), and re-deriving it on every render
	// would reshuffle the rotation mid-fade.
	const [lines] = useState(() => [label, ...loadingLines(task, facts(subject))]);
	const [i, setI] = useState(0);
	const [still, setStill] = useState(
		() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
	);

	useEffect(() => {
		// Reduced motion holds ONE phrase and never swaps. The label, specifically: the
		// honest one is the one worth keeping when only one is allowed.
		if (still || lines.length < 2) return;
		let cancelled = false;
		let timer = setTimeout(function step() {
			if (cancelled) return;
			// Past the end, the rotation loops the phrases rather than replaying the
			// label, which by then has been read and stopped being news.
			setI((n) => (n + 1 >= lines.length ? 1 : n + 1));
			timer = setTimeout(step, ROTATE_MS);
		}, FIRST_SWAP_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [lines, still]);

	// Only here to keep a mid-wait accessibility change honest; the listener costs
	// nothing and the alternative is a line that keeps moving after the user asked
	// everything to stop.
	useEffect(() => {
		if (typeof matchMedia !== 'function') return;
		const mq = matchMedia('(prefers-reduced-motion: reduce)');
		const onChange = () => setStill(mq.matches);
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	}, []);

	return (
		<div class="mt-10 text-center text-muted">
			{/* What is ANNOUNCED is the label, once, from an element that never remounts.
			    The rotation is decoration on this axis: a live region re-reading
			    "Consulting the librarian…" every few seconds is noise, and re-keying the
			    announced element to fade it would announce every phrase. */}
			<span role="status" aria-live="polite" class="sr-only">
				{label}
			</span>
			<span
				key={i}
				aria-hidden="true"
				class={`loading-line inline-block ${still ? '' : 'loading-shimmer'}`}
			>
				{lines[i]}
			</span>
		</div>
	);
}

export { LoadingView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		loading: { label: string; task?: LoadingTask; subject?: string };
	}
}

export default defineView('loading', (v) => (
	<LoadingView label={v.label} task={v.task} subject={v.subject} />
));
