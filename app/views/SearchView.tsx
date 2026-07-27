import type { Hit } from '../core/types.ts';
import { navigateTo } from '../core/actions.ts';
import { defineView } from '../core/view-registry.ts';

function SearchView({ query, hits }: { query: string; hits: Hit[] }) {
	if (!hits.length)
		return <div class="mt-10 text-center text-muted">No matches for “{query}”.</div>;
	return (
		<div class="flex flex-col gap-2">
			{hits.map((h) => (
				<button
					type="button"
					onClick={() => navigateTo(h.path)}
					class="cursor-pointer rounded-lg border border-border p-2.5 text-left hover:border-accent"
				>
					<div class="text-xs text-muted">
						{h.path}:{h.line}
					</div>
					<div>{h.text}</div>
				</button>
			))}
		</div>
	);
}

export { SearchView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		search: { query: string; hits: Hit[] };
	}
}

export default defineView('search', (v) => <SearchView query={v.query} hits={v.hits} />);
