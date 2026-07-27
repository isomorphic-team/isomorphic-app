import { useState } from 'preact/hooks';
import type { BrainRow } from '../core/types.ts';
import { app, callTool, firstText } from '../core/host.ts';
import { show } from '../core/store.ts';
import { openCreateBrain, switchBrain, brainsViewFromSc, openBrains } from '../core/actions.ts';
import { toast, askConfirm } from '../core/toast.tsx';
import { BrainGlyph, CloseIcon } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';

// The brains list (bi-modal counterpart to the header switcher): every brain the user
// can reach, with role, the active one marked. Selecting one switches to it. Wherever
// the user is an org admin they get an "Add a brain" flow (independent of which brain is
// active — you pick which org to add to) and a disconnect ✕ on the brains they manage.
function BrainsView({ brains, active }: { brains: BrainRow[]; active: string }) {
	const [busy, setBusy] = useState(false);
	const [adding, setAdding] = useState(false);
	// Which org the add targets: a representative brain id in that org + its label.
	const [target, setTarget] = useState<{ brainId: string; orgLabel: string } | null>(null);
	const [repos, setRepos] = useState<{ id: string; owner: string; repo: string }[] | null>(null);

	// Orgs the caller can add brains to — deduped from the manageable brains. Available
	// regardless of the active brain, so a viewer-brain being active doesn't hide "Add".
	const manageableOrgs: { orgId: string; orgLabel: string; brainId: string }[] = [];
	const seenOrg = new Set<string>();
	for (const b of brains) {
		if (b.canManage && b.orgId && !seenOrg.has(b.orgId)) {
			seenOrg.add(b.orgId);
			manageableOrgs.push({ orgId: b.orgId, orgLabel: b.orgLabel ?? b.label, brainId: b.id });
		}
	}
	const canAdd = manageableOrgs.length > 0;

	function cancelAdd() {
		setAdding(false);
		setTarget(null);
		setRepos(null);
	}

	async function run(tool: string, args: Record<string, unknown>) {
		if (busy) return;
		setBusy(true);
		const res = await callTool(tool, args);
		setBusy(false);
		if (res.isError) return toast(firstText(res), true);
		toast(firstText(res));
		cancelAdd();
		const sc = (res.structuredContent ?? {}) as Record<string, unknown>;
		// After connecting, land on the new brain's file tree — if its content isn't
		// configured, that view surfaces the Auto-configure button right where they are.
		if (tool === 'connect_brain' && typeof sc.connectedId === 'string') {
			brainsViewFromSc(sc); // refresh the cached list so the switch sees the new brain
			switchBrain(sc.connectedId);
			return;
		}
		// Disconnect / configure change per-brain setup status — re-fetch the list (it
		// recomputes needsConfig) rather than reuse the mutation's rows, which lack it.
		if (tool === 'disconnect_brain' || tool === 'configure_brain') {
			openBrains();
			return;
		}
		show(brainsViewFromSc(sc), { push: false });
	}

	// Load the connectable repos for a chosen org (targeted by a brain in that org).
	async function chooseOrg(o: { orgLabel: string; brainId: string }) {
		setTarget({ brainId: o.brainId, orgLabel: o.orgLabel });
		setRepos(null);
		// No `repo` arg → connect_brain returns the connectable candidates instead of adopting.
		const res = await callTool('connect_brain', { brain: o.brainId });
		if (res.isError) return toast(firstText(res), true);
		const sc = (res.structuredContent ?? {}) as {
			repos?: { id: string; owner: string; repo: string }[];
		};
		setRepos(sc.repos ?? []);
	}

	function startAdd() {
		setAdding(true);
		setRepos(null);
		// One admin org → skip the chooser; several → let the user pick.
		if (manageableOrgs.length === 1) chooseOrg(manageableOrgs[0]);
		else setTarget(null);
	}

	return (
		<div>
			{brains.length === 0 ? (
				<div class="mt-16 text-center">
					<p class="text-muted">No brains yet.</p>
					<button
						type="button"
						onClick={openCreateBrain}
						class="mt-3 rounded-md bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white"
					>
						Create your first brain
					</button>
				</div>
			) : (
				<ul class="flex flex-col">
					{brains.map((b) => (
						<li key={b.id} class="flex items-center border-b border-border last:border-b-0">
							<div class="flex min-w-0 flex-1 items-center gap-3 py-2.5">
								<span
									class={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-chip ${b.id === active ? 'text-accent' : 'text-muted'}`}
								>
									<BrainGlyph />
								</span>
								<span class="min-w-0 flex-1">
									{b.needsConfig ? (
										<span class="block truncate font-medium text-fg" title={b.label}>
											{b.label}
										</span>
									) : (
										<button
											type="button"
											onClick={() => switchBrain(b.id)}
											title={b.id === active ? `Open ${b.label}` : `Switch to ${b.label}`}
											class="block max-w-full truncate border-none bg-transparent p-0 text-left font-medium text-fg hover:underline focus-visible:underline"
										>
											{b.label}
										</button>
									)}
									<span class="block text-xs text-muted">
										{b.role}
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
									<button
										type="button"
										title="Review the setup pull request"
										onClick={() => app.openLink({ url: b.configPrUrl! })}
										class="mr-1 shrink-0 border-none bg-transparent p-0 text-sm text-accent hover:underline"
									>
										Review PR ↗
									</button>
								) : (
									<button
										type="button"
										disabled={busy}
										title={`Set up ${b.label} so its pages appear`}
										onClick={() => run('configure_brain', { brain: b.id })}
										class="mr-1 shrink-0 border-none bg-transparent p-0 text-sm text-accent hover:underline disabled:opacity-50"
									>
										Set up
									</button>
								))}
							{b.canManage && (
								<button
									type="button"
									disabled={busy}
									title={`Disconnect ${b.label}`}
									onClick={async () => {
										const ok = await askConfirm({
											title: 'Disconnect brain?',
											body: `${b.label} will be removed from this workspace. The GitHub repo and its contents are not deleted.`,
											confirmLabel: 'Disconnect'
										});
										if (ok) run('disconnect_brain', { brain: b.id });
									}}
									class="ml-1 shrink-0 rounded p-1 text-muted transition-colors hover:bg-chip hover:text-fg disabled:opacity-50"
								>
									<CloseIcon />
								</button>
							)}
						</li>
					))}
				</ul>
			)}

			{canAdd && (
				<div class="mt-4">
					{!adding ? (
						<button
							type="button"
							onClick={startAdd}
							class="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-chip"
						>
							＋ Add a brain
						</button>
					) : (
						<div class="rounded-md border border-border p-2">
							{!target ? (
								// Choose which org to add to (only shown with 2+ admin orgs).
								<>
									<div class="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted">
										Add to which organization?
									</div>
									<ul class="flex flex-col">
										{manageableOrgs.map((o) => (
											<li key={o.orgId}>
												<button
													type="button"
													onClick={() => chooseOrg(o)}
													class="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-sm text-fg hover:bg-chip"
												>
													<span class="text-muted">
														<BrainGlyph />
													</span>
													<span class="truncate">{o.orgLabel}</span>
												</button>
											</li>
										))}
									</ul>
								</>
							) : (
								// Pick a repo to adopt into the chosen org.
								<>
									<div class="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted">
										Add a repo to {target.orgLabel}
									</div>
									{repos === null ? (
										<div class="px-1 py-2 text-sm text-muted">Loading repos…</div>
									) : repos.length === 0 ? (
										<div class="px-1 py-2 text-sm text-muted">
											No unconnected repos in this org’s installation. Add the repo to the
											Isomorphic App installation on GitHub first.
										</div>
									) : (
										<ul class="flex flex-col">
											{repos.map((r) => (
												<li key={r.id}>
													<button
														type="button"
														disabled={busy}
														onClick={() =>
															run('connect_brain', { repo: r.id, brain: target.brainId })
														}
														class="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-sm text-fg hover:bg-chip disabled:opacity-50"
													>
														<span class="text-muted">
															<BrainGlyph />
														</span>
														<span class="truncate">{r.id}</span>
													</button>
												</li>
											))}
										</ul>
									)}
								</>
							)}
							<button
								type="button"
								onClick={cancelAdd}
								class="mt-1 px-1.5 py-1 text-xs text-muted hover:text-fg"
							>
								Cancel
							</button>
						</div>
					)}
				</div>
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

export default defineView('brains', (v) => <BrainsView brains={v.brains} active={v.active} />);
