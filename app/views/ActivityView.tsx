import type { ActivityEntry } from '../core/types.ts';
import { app } from '../core/host.ts';
import { navigateTo } from '../core/actions.ts';
import { relativeTime } from '../core/util.ts';
import { InitialsAvatar } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';

// Our librarian tools format commit subjects as "Action Title (wiki/path.md)". In the
// feed the trailing path is redundant — the title itself is the click-to-open target —
// so strip a trailing parenthetical that looks like a path. Non-path messages (e.g.
// "Scaffold brain") are left untouched.
function changeTitle(e: ActivityEntry): string {
	return e.message.replace(/\s*\([^()]*\/[^()]*\)\s*$/, '').trim() || e.message;
}

// Activity / audit feed: recent changes (who, what, when) with a link to each
// commit and, when the change touched a page, a jump straight to it. Whole-brain
// by default; `scopePath` set means it's one page's history.
function ActivityView({ entries, scopePath }: { entries: ActivityEntry[]; scopePath?: string }) {
	// No in-body title: the header breadcrumb already reads "Recent changes" (+ the
	// scoped path). The feed is the whole body.
	return (
		<div>
			{entries.length === 0 ? (
				<div class="mt-16 text-center text-muted">
					{scopePath ? 'No changes for this page yet.' : 'No changes recorded yet.'}
				</div>
			) : (
				<ul class="flex flex-col">
					{entries.map((e) => (
						<li
							key={e.sha}
							class="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0"
						>
							<InitialsAvatar name={e.authorName} />
							<div class="min-w-0 flex-1">
								<div class="flex items-baseline gap-2">
									{e.path ? (
										<button
											type="button"
											onClick={() => navigateTo(e.path!)}
											title={e.message}
											class="min-w-0 flex-1 truncate border-none bg-transparent p-0 text-left font-medium text-fg hover:underline focus-visible:underline"
										>
											{changeTitle(e)}
										</button>
									) : (
										<span class="min-w-0 flex-1 truncate font-medium text-fg" title={e.message}>
											{changeTitle(e)}
										</span>
									)}
									<span class="shrink-0 text-xs text-muted" title={e.date}>
										{relativeTime(e.date)}
									</span>
								</div>
								<div class="mt-0.5 flex items-baseline gap-1.5 text-xs text-muted">
									<span class="truncate" title={e.authorName}>
										{e.authorName}
									</span>
									<span aria-hidden="true">·</span>
									<button
										type="button"
										onClick={() => app.openLink({ url: e.url })}
										title={`View commit ${e.sha}`}
										class="shrink-0 border-none bg-transparent p-0 text-muted hover:text-fg hover:underline"
									>
										{e.shortSha}
									</button>
								</div>
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

export { ActivityView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		activity: { entries: ActivityEntry[]; scopePath?: string };
	}
}

export default defineView('activity', (v) => (
	<ActivityView entries={v.entries} scopePath={v.scopePath} />
));
