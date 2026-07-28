import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { BrainRow } from '../core/types.ts';
import { app, callTool, firstText } from '../core/host.ts';
import { show } from '../core/store.ts';
import {
	switchBrain,
	brainsViewFromSc,
	openBrains,
	openAddBrain,
	openBrainAccess,
	manageableOrgs
} from '../core/actions.ts';
import { toast, askConfirm } from '../core/toast.tsx';
import { BrainGlyph, CloseIcon } from '../core/icons.tsx';
import { groupBrainsByOrg } from '../core/util.ts';
import { defineView } from '../core/view-registry.ts';
import { Button, List, ListRow, listRowTitle, eyebrow } from '../ui/index.ts';

// The brains list (bi-modal counterpart to the header switcher): every brain the user
// can reach, with role, the active one marked. Selecting one switches to it. Wherever
// the user is an org admin they get an "Add brain" action in the header and a
// disconnect ✕ on the brains they manage.
//
// Adding opens its OWN view (AddBrainView) rather than an inline composer, because it
// picks from two lists of unknown length. This screen therefore holds no add state at
// all — see app/ui/Flow.tsx, where every add-shaped action in the app now lands.
function BrainsView({ brains, active }: { brains: BrainRow[]; active: string }) {
	const [busy, setBusy] = useState(false);

	async function run(tool: string, args: Record<string, unknown>) {
		if (busy) return;
		setBusy(true);
		const res = await callTool(tool, args);
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast(firstText(res));
		const sc = (res.structuredContent ?? {}) as Record<string, unknown>;
		// Disconnect / configure change per-brain setup status — re-fetch the list (it
		// recomputes needsConfig) rather than reuse the mutation's rows, which lack it.
		if (tool === 'disconnect_brain' || tool === 'configure_brain') {
			openBrains();
			return;
		}
		show(brainsViewFromSc(sc), { push: false });
	}

	return (
		<div>
			{brains.length === 0 ? (
				<div class="mt-16 text-center">
					<p class="text-muted">No brains yet.</p>
					<Button onClick={() => openAddBrain()} class="mt-3">
						Create your first brain
					</Button>
				</div>
			) : (
				<List>
					{/* Same org grouping as the crumb's brain picker, for the same reason: the
					    label no longer carries the org, and this screen is the other place two
					    orgs' brains sit in one list. The heading is a <li> because List is a
					    <ul> — a bare <div> in there is invalid markup. */}
					{groupBrainsByOrg(brains).map((g) => (
						<Fragment key={g.org ?? '·'}>
							{g.org && <li class={`px-0 pb-0.5 pt-2 first:pt-0 ${eyebrow}`}>{g.org}</li>}
							{g.rows.map((b) => (
								<ListRow key={b.id} class="gap-0 py-0">
									<div class="flex min-w-0 flex-1 items-center gap-2 py-1.5">
										<span
											class={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-chip ${b.id === active ? 'text-accent' : 'text-muted'}`}
										>
											<BrainGlyph />
										</span>
										<span class="min-w-0 flex-1">
											{b.needsConfig ? (
												<span class="block truncate font-medium text-fg" title={b.label}>
													{b.label}
												</span>
											) : (
												<Button
													variant="link"
													onClick={() => switchBrain(b.id)}
													title={b.id === active ? `Open ${b.label}` : `Switch to ${b.label}`}
													class={`block max-w-full ${listRowTitle}`}
												>
													{b.label}
												</Button>
											)}
											<span class="block text-xs text-muted">
												{b.role}
												{b.visibility === 'private' ? ' · private' : ''}
												{b.configPrUrl
													? ' · setup pending review'
													: b.needsConfig
														? ' · not configured'
														: ''}
											</span>
										</span>
										{b.id === active && !b.needsConfig && (
											<span class="shrink-0 text-sm text-accent">Active</span>
										)}
									</div>
									{b.needsConfig &&
										(b.configPrUrl ? (
											// A configure PR is open (protected repo) — link to it instead of
											// opening another. Merging it makes the pages appear automatically.
											<Button
												variant="link"
												title="Review the setup pull request"
												onClick={() => app.openLink({ url: b.configPrUrl! })}
												class="mr-1"
											>
												Review PR ↗
											</Button>
										) : (
											<Button
												variant="link"
												disabled={busy}
												title={`Set up ${b.label} so its pages appear`}
												onClick={() => run('configure_brain', { brain: b.id })}
												class="mr-1"
											>
												Set up
											</Button>
										))}
									{b.canShare && !b.needsConfig && (
										<Button
											variant="ghost"
											size="sm"
											disabled={busy}
											title={`Manage who can access ${b.label}`}
											onClick={() => openBrainAccess(b.id)}
											class="ml-1"
										>
											Share
										</Button>
									)}
									{b.canManage && (
										<Button
											variant="ghost"
											size="icon"
											disabled={busy}
											title={`Disconnect ${b.label}`}
											aria-label={`Disconnect ${b.label}`}
											onClick={async () => {
												const ok = await askConfirm({
													title: 'Disconnect brain?',
													body: `${b.label} will be removed from this workspace. The GitHub repo and its contents are not deleted.`,
													confirmLabel: 'Disconnect'
												});
												if (ok) run('disconnect_brain', { brain: b.id });
											}}
											class="ml-1"
										>
											<CloseIcon />
										</Button>
									)}
								</ListRow>
							))}
						</Fragment>
					))}
				</List>
			)}
		</div>
	);
}

export { BrainsView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		brains: { brains: BrainRow[]; active: string };
	}
}

export default defineView('brains', (v) => <BrainsView brains={v.brains} active={v.active} />, {
	// Unconditional: creating a brain is always available (the switcher has always
	// offered it to everyone), and connecting is the OTHER source inside the same
	// flow rather than a separate action to gate. The flow drops its source chooser
	// by itself when there is no org to connect to.
	actions: (v) => [
		{
			key: 'add-brain',
			label: 'Add brain',
			title: 'Create a new brain, or connect an existing repo',
			onClick: () => openAddBrain({ orgs: manageableOrgs(v.brains), first: false })
		}
	]
});
