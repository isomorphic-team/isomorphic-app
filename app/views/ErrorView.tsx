import { openBrowse } from '../core/actions.ts';
import { defineView } from '../core/view-registry.ts';

function ErrorView({
	headline,
	detail,
	retry
}: {
	headline: string;
	detail?: string;
	retry?: () => void;
}) {
	return (
		<div class="mt-10 text-center text-muted">
			<p class="font-bold text-fg">{headline}</p>
			{detail && <p class="mt-1 text-sm">{detail}</p>}
			<button
				type="button"
				onClick={() => (retry ? retry() : openBrowse())}
				class="mt-3 cursor-pointer rounded-md border border-border px-3.5 py-1.5 text-[13px] text-fg"
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
