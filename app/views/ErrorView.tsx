import { openBrowse } from '../core/actions.ts';
import { defineView } from '../core/view-registry.ts';
import { isHostDenial } from '../core/util.ts';
import { viewTitle } from '../ui/typography.ts';

function ErrorView({
	headline,
	detail,
	retry
}: {
	headline: string;
	detail?: string;
	retry?: () => void;
}) {
	// Every error surface funnels through here, so the client-denial rewrite is done
	// once at the render seam rather than at each of the dozen call sites that catch
	// a tool error and pass its text along.
	const denied = isHostDenial(detail);
	return (
		<div class="mt-10 text-center text-muted">
			<p class={viewTitle}>{denied ? "Claude didn't allow this tool call." : headline}</p>
			{denied ? (
				<p class="mt-1 text-sm">
					Your Claude client blocked it before it reached Isomorphic. Approve the permission and try
					again.
				</p>
			) : (
				detail && <p class="mt-1 text-sm">{detail}</p>
			)}
			<button
				type="button"
				onClick={() => (retry ? retry() : openBrowse())}
				class="mt-3 cursor-pointer rounded-md border border-border px-3.5 py-1.5 text-sm text-fg"
			>
				{retry ? 'Retry' : 'Browse files'}
			</button>
		</div>
	);
}

export { ErrorView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		error: { headline: string; detail?: string; retry?: () => void };
	}
}

export default defineView('error', (v) => (
	<ErrorView headline={v.headline} detail={v.detail} retry={v.retry} />
));
