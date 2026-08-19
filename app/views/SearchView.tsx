import type { Hit } from '../core/types.ts';
import { openHit, runSearch } from '../core/actions.ts';
import { brainList } from '../core/store.ts';
import { defineView } from '../core/view-registry.ts';

function SearchView({ query, hits, scope }: { query: string; hits: Hit[]; scope?: 'all' }) {
	// Offered only when there is somewhere else to look. Widening is a deliberate second
	// click rather than the default, so an ordinary search keeps an ordinary reach.
	const canWiden = scope !== 'all' && (brainList?.length ?? 0) > 1;
	const wider = canWiden ? (
		<button
			type="button"
			onClick={() => runSearch(query, 'all')}
			class="mt-3 cursor-pointer self-center text-sm text-muted underline hover:text-fg"
		>
			Search all your brains
		</button>
	) : null;

	if (!hits.length)
		return (
			<div class="mt-10 flex flex-col text-center text-muted">
				<div>No matches for “{query}”.</div>
				{wider}
			</div>
		);

	return (
		<div class="flex flex-col gap-2">
			{hits.map((h) => (
				<button
					key={`${h.brain ?? ''}:${h.path}:${h.line}`}
					type="button"
					onClick={() => openHit(h)}
					class="cursor-pointer rounded-lg border border-border p-2.5 text-left hover:border-accent"
				>
					<div class="flex gap-1.5 text-xs text-muted">
						{/* The brain rides in front of the path, not behind it: a result set that
						    does not say which brain each line came from is how one client's
						    material gets quoted into another client's conversation. */}
						{h.brainLabel && <span class="shrink-0 text-accent">{h.brainLabel}</span>}
						<span class="min-w-0 truncate">
							{h.path}:{h.line}
						</span>
					</div>
					<div>{h.text}</div>
				</button>
			))}
			{wider}
		</div>
	);
}

export { SearchView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		search: { query: string; hits: Hit[]; scope?: 'all' };
	}
}

export default defineView('search', (v) => (
	<SearchView query={v.query} hits={v.hits} scope={v.scope} />
));
