// Search is a PAGE, and it owns its own field.
//
// It used to be a control in the chrome that swapped the trail for an input — the one
// item in the rail that opened a widget rather than going somewhere, which a rail of
// peers makes obvious. Everything else there is a place you arrive at; this now is too.
// The field being ON the page is what makes that true, and it buys three things the
// chrome version could not have: room to read a long query, the query still visible
// while you read the results, and somewhere to put the empty state.
import { useEffect, useRef } from 'preact/hooks';
import type { Hit } from '../core/types.ts';
import { openHit, runSearch } from '../core/actions.ts';
import { SearchIcon } from '../core/icons.tsx';
import { brainList } from '../core/store.ts';
import { defineView } from '../core/view-registry.ts';

function SearchView({ query, hits, scope }: { query: string; hits: Hit[]; scope?: 'all' }) {
	const ref = useRef<HTMLInputElement>(null);
	// Focus on arrival: reaching this page is the act of intending to type. Keyed on the
	// query so running a search does not steal focus back on every re-render, and so
	// returning to an empty search is ready to type again.
	useEffect(() => {
		if (!query) ref.current?.focus();
	}, [query]);
	// Offered only when there is somewhere else to look. Widening is a deliberate second
	// click rather than the default, so an ordinary search keeps an ordinary reach.
	const canWiden = !!query && scope !== 'all' && (brainList?.length ?? 0) > 1;
	const wider = canWiden ? (
		<button
			type="button"
			onClick={() => runSearch(query, 'all')}
			class="mt-3 cursor-pointer self-center text-sm text-muted underline hover:text-fg"
		>
			Search all your brains
		</button>
	) : null;
	return (
		<div class="flex flex-col gap-4">
			<div class="flex items-center gap-2 rounded-lg border border-border px-3 py-2 focus-within:border-accent">
				<span class="shrink-0 text-muted">
					<SearchIcon />
				</span>
				<input
					ref={ref}
					type="search"
					// The query is the page's state, so the field SHOWS it rather than
					// starting blank over its own results. `key` remounts the field when the
					// query changes, which is what lets a defaultValue track it without the
					// field fighting the user's typing on every keystroke.
					key={query}
					defaultValue={query}
					placeholder={scope === 'all' ? 'Search all your brains…' : 'Search this brain…'}
					onKeyDown={(e) => {
						if (e.key === 'Enter') runSearch((e.target as HTMLInputElement).value, scope);
					}}
					class="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
				/>
			</div>
			{!query ? (
				// The arrival state. Not "no results" — nothing has been asked yet, and
				// saying "no matches for ''" would report a failure that never happened.
				<div class="mt-6 text-center text-sm text-muted">
					Search the pages of this brain by their text.
				</div>
			) : !hits.length ? (
				<div class="mt-6 flex flex-col text-center text-muted">
					<div>No matches for “{query}”.</div>
					{wider}
				</div>
			) : (
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
			)}
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
