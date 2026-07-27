import { defineView } from '../core/view-registry.ts';

function LoadingView({ label }: { label: string }) {
	return <div class="mt-10 text-center text-muted">{label}</div>;
}

export { LoadingView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		loading: { label: string };
	}
}

export default defineView('loading', (v) => <LoadingView label={v.label} />);
