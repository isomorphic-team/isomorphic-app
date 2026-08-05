import { useEffect, useState } from 'preact/hooks';
import { formatBytes, isEmbeddable, isModelViewable } from '../../src/lib/media.ts';
import type { Backref } from '../core/types.ts';
import { callTool } from '../core/host.ts';
import { brainArgs } from '../core/store.ts';
import { navigateTo } from '../core/actions.ts';
import { defineView } from '../core/view-registry.ts';
import { eyebrow } from '../ui/typography.ts';

// One attachment, on its own.
//
// This view exists because assets became browsable in the file tree, and a row you
// can click has to land somewhere. What it answers, in the order someone actually
// asks: what does it look like, what is it, and which pages depend on it — that last
// one being the question you need answered BEFORE deleting anything.
//
// Deliberately read-only for now. Move and delete already work through move_page and
// delete_page, and putting a destructive button next to a picture whose references
// are still loading is how someone removes an image from five pages by accident.

// Which pages show this attachment. The same find_inbound_links the page view uses:
// it works on an asset path with no change, because backlinksTo reads asset edges.
// That is the payoff of keeping attachments in the link graph rather than treating
// them as loose files.
function UsedOn({ path }: { path: string }) {
	const [state, setState] = useState<{ loading: boolean; refs: Backref[] }>({
		loading: true,
		refs: []
	});

	useEffect(() => {
		let cancelled = false;
		setState({ loading: true, refs: [] });
		callTool('find_inbound_links', { path, ...brainArgs() })
			.then((result) => {
				if (cancelled) return;
				const sc = (result.structuredContent ?? {}) as { refs?: Backref[] };
				setState({
					loading: false,
					refs: !result.isError && Array.isArray(sc.refs) ? sc.refs : []
				});
			})
			.catch(() => {
				if (!cancelled) setState({ loading: false, refs: [] });
			});
		return () => {
			cancelled = true;
		};
	}, [path]);

	if (state.loading) return null;

	return (
		<section class="mt-8 border-t border-border pt-4">
			{/* No count in the heading: the list under it is the count, and each row
			    already carries its own. */}
			<h2 class={`mb-2.5 ${eyebrow}`}>Used on</h2>
			{state.refs.length === 0 ? (
				// Worth stating plainly rather than showing an empty list: an unreferenced
				// attachment is invisible everywhere else in the app, and still costs space
				// in every clone of the repo forever.
				<p class="text-sm text-muted">
					No page shows this file. It stays in the brain until someone deletes it.
				</p>
			) : (
				<ul class="flex flex-col gap-0.5">
					{state.refs.map((r) => (
						<li key={r.path}>
							<button
								type="button"
								onClick={() => navigateTo(r.path)}
								class="flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-md border-none bg-transparent px-2 py-1 text-left text-sm text-fg hover:bg-chip"
							>
								<span class="truncate">{r.title}</span>
								<span class="shrink-0 tabular-nums text-xs text-muted">
									{r.mdCount + r.wikiCount}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function AssetView({
	path,
	mimeType,
	size,
	dataUri
}: {
	path: string;
	mimeType: string;
	size: number;
	dataUri: string;
}) {
	const name = path.split('/').pop() ?? path;
	const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	const embeddable = isEmbeddable(path) && !!dataUri;

	return (
		<div>
			<h1 class="mb-0.5 text-lg font-semibold break-words text-fg">{name}</h1>
			<p class="mb-4 text-xs break-all text-muted">{path}</p>

			{embeddable ? (
				// Checkered backing rather than a flat panel: a transparent PNG on a solid
				// background reads as an opaque white rectangle, and "is this transparent?"
				// is one of the few things you open an image on its own to find out.
				<div class="asset-canvas flex items-center justify-center rounded-lg border border-border p-4">
					<img src={dataUri} alt={name} class="max-h-[60vh] max-w-full object-contain" />
				</div>
			) : (
				<div class="rounded-lg border border-dashed border-border px-4 py-6 text-center">
					<p class="text-sm text-fg">{mimeType || 'Unknown type'}</p>
					<p class="mt-1 text-xs text-muted">
						Stored in the brain. This type can&rsquo;t be previewed here.
					</p>
				</div>
			)}

			<dl class="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
				<dt class="text-muted">Type</dt>
				<dd class="text-fg">{mimeType || '—'}</dd>
				<dt class="text-muted">Size</dt>
				<dd class="tabular-nums text-fg">{size ? formatBytes(size) : '—'}</dd>
				{folder && (
					<>
						<dt class="text-muted">Folder</dt>
						<dd class="truncate text-fg">{folder}</dd>
					</>
				)}
				<dt class="text-muted">Claude can see it</dt>
				{/* Not trivia. It is the difference between "ask Claude what this diagram
				    says" working and quietly doing nothing, and the answer is not guessable
				    from the file — a PDF and an SVG both look like documents here. */}
				<dd class="text-fg">
					{isModelViewable(mimeType) ? 'Yes' : 'No — stored and shown, but not readable by Claude'}
				</dd>
			</dl>

			<UsedOn path={path} />
		</div>
	);
}

export { AssetView, UsedOn };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		asset: { path: string; mimeType: string; size: number; dataUri: string };
	}
}

export default defineView('asset', (v) => (
	<AssetView path={v.path} mimeType={v.mimeType} size={v.size} dataUri={v.dataUri} />
));
