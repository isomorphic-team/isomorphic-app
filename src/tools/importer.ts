// sync_records — the non-destructive bulk importer (FR-3, derived-views PRD
// Phase 3). The planner (src/lib/brain-import.ts) holds the semantics; this
// tool gathers its inputs and lands the plan through the standard write path:
//
//   ensureFresh → discover claimed pages via the frontmatter index → fetch
//   those pages' AUTHORITATIVE blobs → plan → one commitOrPR bundle
//   (pages + ledger + changelog), PR/auto-merge per the brain's writeMode.
//
// Chunking contract: records arrive in batches of ≤ MAX_RECORDS_PER_CALL; any
// call MAY carry the source's complete key `manifest`, which is what enables
// deletion PROPOSALS (never deletes). Typical run: N chunk calls, the last one
// carrying the manifest. Every call is independently safe and idempotent.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
	plan,
	planDecisions,
	parseLedger,
	serializeLedger,
	ledgerPath,
	SOURCE_KEY_FIELD,
	SOURCE_KEYS_FIELD,
	type ClaimedPage,
	type ImportDecision,
	type ImportRecord
} from '../lib/brain-import.ts';
import { ensureFresh, loadAllFields } from '../lib/brain-index.ts';
import { hasViews, renderViews, buildViewContext } from '../lib/views.ts';
import { insertLogEntry, todayIso } from '../lib/wiki.ts';
import { isContentPath, logPathOf } from '../lib/brain-config.ts';
import {
	isImportKey,
	parseImportKey,
	parseReviewLedger,
	serializeReviewLedger,
	dismissFinding,
	undismissFinding,
	REVIEW_LEDGER_PATH
} from '../lib/findings.ts';
import type { BrainContext } from './librarian.ts';
import type { TenantOpts } from '../lib/orgs.ts';

const MAX_RECORDS_PER_CALL = 200;

// Keys the importer itself owns — a source may never write them via `fields`.
const RESERVED_FIELDS = new Set([SOURCE_KEY_FIELD, SOURCE_KEYS_FIELD, 'updated']);

const brainArg = z
	.string()
	.optional()
	.describe('Which brain to target (name/handle). Defaults to the active brain.');

function ok(text: string, structured?: Record<string, unknown>) {
	return {
		content: [{ type: 'text' as const, text }],
		...(structured ? { structuredContent: structured } : {})
	};
}

function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

export function registerImportTools(
	server: McpServer,
	getContext: (opts?: TenantOpts) => Promise<BrainContext>
) {
	server.registerTool(
		'sync_records',
		{
			title: 'Sync records from an external source',
			description:
				'Non-destructively upsert a batch of keyed records from an external source (spreadsheet, CRM…) into the brain. Creates new pages, updates ONLY the declared source-owned frontmatter on existing pages (found by source_key, wherever they moved), and never touches human-written prose, human-added fields, or pages. Deletions are only ever PROPOSED (pass the full key manifest to detect them). Send large imports in batches; include `manifest` on the final call. Re-running with unchanged data is a no-op.',
			inputSchema: {
				brain: brainArg,
				source: z
					.string()
					.regex(/^[a-z0-9][a-z0-9_-]*$/)
					.describe('Stable id of the source feed, e.g. "contacts-spreadsheet".'),
				records: z
					.array(
						z.object({
							key: z.string().describe('Stable identity from the source (email, row id…).'),
							path: z
								.string()
								.optional()
								.describe('Where to create the page on FIRST import (ignored for updates).'),
							fields: z
								.record(z.union([z.string(), z.array(z.string())]))
								.describe('Frontmatter facts. Only source-owned keys are ever written.'),
							body: z.string().optional().describe('Initial body markdown (create only).')
						})
					)
					.max(MAX_RECORDS_PER_CALL)
					.describe(`This batch of records (max ${MAX_RECORDS_PER_CALL} per call).`),
				source_owned: z
					.array(z.string())
					.min(1)
					.describe('Frontmatter keys the source owns and may update, e.g. ["title","email"].'),
				manifest: z
					.array(z.string())
					.optional()
					.describe(
						"The source's COMPLETE key set. When present, keys previously imported but now absent are reported as proposed deletions (never deleted)."
					),
				adopt_existing: z
					.boolean()
					.optional()
					.describe(
						'Bind records to EXISTING unclaimed pages at their paths (merge source-owned fields, add the key, keep the body) instead of erroring. For adopting a brain that predates import keys. Default false.'
					),
				dry_run: z.boolean().optional().describe('Plan and report only — no write. Default false.')
			}
		},
		async ({ source, records, source_owned, manifest, adopt_existing, dry_run, brain }) => {
			const ctx = await getContext({ requires: 'editor', brain });
			const { store, repoArgs, config, author, db, brainId } = ctx;

			if (config.sourceOfTruth === 'source') {
				return fail(
					'This brain declares sourceOfTruth: "source", which is not supported yet — the importer only implements app-authored semantics (curation wins). Remove the declaration to import.'
				);
			}
			const reserved = source_owned.filter((k) => RESERVED_FIELDS.has(k));
			if (reserved.length) {
				return fail(`source_owned may not include importer-managed keys: ${reserved.join(', ')}.`);
			}
			// Strip reserved keys from record fields — a source can't claim keys or
			// forge bindings through the fields bag.
			const cleanRecords: ImportRecord[] = records.map((r) => ({
				...r,
				fields: Object.fromEntries(
					Object.entries(r.fields).filter(([k]) => !RESERVED_FIELDS.has(k))
				)
			}));
			const badPath = cleanRecords.find(
				(r) => r.path && !isContentPath(r.path.trim().replace(/^\/+/, ''), config)
			);
			if (badPath) {
				return fail(
					`Record "${badPath.key}" targets "${badPath.path}", which is outside this brain's editable content.`
				);
			}

			// Freshness first — key discovery and diffs must reflect repo HEAD.
			await ensureFresh(db, store, repoArgs, brainId, config);

			// Which pages claim which keys (source_key / source_keys frontmatter,
			// straight from the index — discovery only, never the diff basis).
			const allFields = await loadAllFields(db, brainId);
			const claimsByPath = new Map<string, string[]>();
			for (const [path, fields] of allFields) {
				const keys = [
					...(fields.get(SOURCE_KEY_FIELD) ?? []),
					...(fields.get(SOURCE_KEYS_FIELD) ?? [])
				];
				if (keys.length) claimsByPath.set(path, keys);
			}

			// Authoritative blobs for pages matched by THIS batch's records (the ones
			// we may diff/rewrite), plus — in adopt mode — existing unclaimed pages
			// at record paths. Deletion detection needs only paths+keys.
			const recordKeys = new Set(cleanRecords.map((r) => r.key.trim()));
			const matchedPaths = new Set(
				[...claimsByPath].filter(([, keys]) => keys.some((k) => recordKeys.has(k))).map(([p]) => p)
			);
			const head = await store.getHead(repoArgs, config.defaultBranch);
			const tree = await store.listTree(repoArgs, head);
			const treePaths = new Set(tree.map((e) => e.path));
			const existingPaths = new Set([...treePaths].filter((p) => isContentPath(p, config)));
			const adoptPaths = new Set<string>();
			if (adopt_existing) {
				for (const r of cleanRecords) {
					const p = r.path?.trim().replace(/^\/+/, '');
					if (p && existingPaths.has(p) && !claimsByPath.has(p)) adoptPaths.add(p);
				}
			}
			const { pages: matchedPages } = await store.fetchPages(
				repoArgs,
				tree.filter((e) => matchedPaths.has(e.path) || adoptPaths.has(e.path))
			);
			const contentByPath = new Map(matchedPages.map((p) => [p.path, p.content]));
			const claimed: ClaimedPage[] = [...claimsByPath].map(([path, keys]) => ({
				path,
				keys,
				content: contentByPath.get(path) ?? '' // deletion-only pages need no content
			}));
			const adoptable = adopt_existing
				? new Map([...adoptPaths].map((p) => [p, contentByPath.get(p) ?? '']))
				: undefined;

			// The source's ledger — importer-owned state in the repo.
			const ledgerFile = await store.readFile(repoArgs, ledgerPath(source));
			let ledger;
			try {
				ledger = parseLedger(ledgerFile?.content ?? null);
			} catch {
				return fail(
					`The import ledger (${ledgerPath(source)}) is corrupt. Fix or delete it before importing — proceeding without it could resurrect pages your team deliberately removed.`
				);
			}

			const p = plan({
				records: cleanRecords,
				manifest,
				sourceOwned: source_owned,
				claimed,
				ledger,
				existingPaths,
				adoptable
			});

			const adoptedCount = p.writes.filter((w) => w.kind === 'adopt').length;
			const summary = [
				`${p.writes.filter((w) => w.kind === 'create').length} created`,
				`${p.writes.filter((w) => w.kind === 'update').length} updated`,
				...(adoptedCount ? [`${adoptedCount} adopted`] : []),
				`${p.unchanged.length} unchanged`,
				...(p.suppressed.length ? [`${p.suppressed.length} suppressed`] : []),
				...(p.errors.length ? [`${p.errors.length} error(s)`] : [])
			].join(', ');
			const decisions = [
				...p.needsDecision.map((d) => `- "${d.key}": ${d.reason}`),
				...p.proposedDeletions.map(
					(d) =>
						`- "${d.key}" (${d.path}) is no longer in the source — delete it, or keep it and suppress the key`
				)
			];
			const decisionText = decisions.length
				? `\n\nNeeds a human decision (nothing was changed for these):\n${decisions.join('\n')}`
				: '';
			const structured = {
				source,
				created: p.writes
					.filter((w) => w.kind === 'create')
					.map((w) => ({ key: w.key, path: w.path })),
				updated: p.writes
					.filter((w) => w.kind === 'update')
					.map((w) => ({ key: w.key, path: w.path, changedFields: w.changedFields })),
				adopted: p.writes
					.filter((w) => w.kind === 'adopt')
					.map((w) => ({ key: w.key, path: w.path, changedFields: w.changedFields })),
				unchanged: p.unchanged.length,
				suppressed: p.suppressed,
				needsDecision: p.needsDecision,
				proposedDeletions: p.proposedDeletions,
				errors: p.errors
			};

			const ledgerChanged = serializeLedger(p.ledgerAfter) !== serializeLedger(ledger);
			if (dry_run || (p.writes.length === 0 && !ledgerChanged)) {
				const label = dry_run
					? 'Dry run — nothing written.'
					: 'Everything is already in sync — nothing to write.';
				return ok(`${label} ${summary}.${decisionText}`, { ...structured, dryRun: !!dry_run });
			}

			// Regenerate view snapshots on the way through, like every write path.
			let writes = p.writes.map((w) => ({ path: w.path, content: w.content }));
			if (writes.some((w) => hasViews(w.content))) {
				try {
					const viewCtx = await buildViewContext(db, brainId, config);
					writes = await Promise.all(
						writes.map(async (w) =>
							hasViews(w.content)
								? { ...w, content: (await renderViews(w.content, w.path, viewCtx)).snapshotted }
								: w
						)
					);
				} catch {
					// fail-open: unsnapshotted content is still correct content
				}
			}
			if (ledgerChanged) {
				writes.push({ path: ledgerPath(source), content: serializeLedger(p.ledgerAfter) });
			}
			const log = await store.readFile(repoArgs, logPathOf(config));
			if (log && p.writes.length) {
				writes.push({
					path: logPathOf(config),
					content: insertLogEntry(log.content, todayIso(), `Imported from "${source}": ${summary}.`)
				});
			}

			const outcome = await store.commitOrPR(repoArgs, {
				writeMode: config.writeMode,
				defaultBranch: config.defaultBranch,
				author,
				autoMerge: config.autoMerge,
				mergeMethod: config.mergeMethod,
				message: `Import from ${source}: ${summary}\n\nNon-destructive sync — source-owned fields only; deletions proposed, not applied.`,
				writes,
				head,
				branchPrefix: 'isomorphic/import',
				prTitle: `Import from ${source}`,
				prBody: `Upsert ${p.writes.length} page(s) from source \`${source}\` (${summary}). Human content untouched; deletions only proposed. Via the Isomorphic brain tools.`
			});

			const landed =
				outcome.prUrl && !outcome.merged
					? outcome.autoMergeEnabled
						? ` It will merge automatically once checks pass: ${outcome.prUrl}`
						: ` Review and merge it here: ${outcome.prUrl}`
					: '';
			return ok(`Imported from "${source}": ${summary}.${landed}${decisionText}`, {
				...structured,
				prUrl: outcome.prUrl
			});
		}
	);

	server.registerTool(
		'resolve',
		{
			title: 'Record a decision about a finding',
			description:
				'`resolve` answers the findings `validate` reports, durably, so they stop being re-raised. Every finding validate prints carries a `[key]`; pass that key here with what you decided. For a CONSOLIDATION or STRUCTURE finding (a page nothing links to, a mixed folder-note convention, wikilink portability, a missing `type:`): "dismiss" records that the shape is deliberate and validate stops reporting it, and "undismiss" reverses that. For an IMPORT finding (a key a sync_records run could not decide alone): "delete" removes the page a proposed deletion pointed at, "alias" binds the key onto a surviving page (how a consolidation claims a duplicate\'s identity), "suppress" never imports the key again, and "recreate" forgets it so the next sync makes its page fresh. Dismissing is not a fix and never edits a page — it records that a human looked and chose this. Broken links have no key and cannot be resolved; fix them instead.',
			inputSchema: {
				brain: brainArg,
				decisions: z
					.array(
						z.object({
							finding: z
								.string()
								.describe('The `[key]` validate printed for this finding, copied exactly.'),
							action: z.enum(['dismiss', 'undismiss', 'delete', 'alias', 'suppress', 'recreate']),
							why: z
								.string()
								.optional()
								.describe(
									'For "dismiss": why this shape is deliberate. Recorded in the brain so the next reader knows it was a decision rather than an oversight.'
								),
							alias_to: z
								.string()
								.optional()
								.describe('For "alias": path of the surviving page that claims the key.')
						})
					)
					.min(1)
					.max(100)
			}
		},
		async ({ decisions: allDecisions, brain }) => {
			const ctx = await getContext({ requires: 'editor', brain });
			const { store, repoArgs, config, author, db, brainId } = ctx;

			const importDecisions = allDecisions.filter((d) => isImportKey(d.finding));
			const reviewDecisions = allDecisions.filter((d) => !isImportKey(d.finding));

			const misrouted = reviewDecisions.find(
				(d) => d.action !== 'dismiss' && d.action !== 'undismiss'
			);
			if (misrouted)
				return fail(
					`"${misrouted.action}" only applies to an import finding. "${misrouted.finding}" is a structure or consolidation finding, which takes "dismiss" or "undismiss".`
				);
			const importMisrouted = importDecisions.find(
				(d) => d.action === 'dismiss' || d.action === 'undismiss'
			);
			if (importMisrouted)
				return fail(
					`"${importMisrouted.finding}" is an import finding: answer it with delete / alias / suppress / recreate rather than dismissing it, so the next sync knows what to do.`
				);

			// One ledger per call. Import decisions land in the importer's per-source
			// ledger and dismissals in the review ledger, which are different files and
			// therefore different commits; rather than write two, ask for two calls.
			if (importDecisions.length && reviewDecisions.length)
				return fail(
					'Import findings and structure findings are recorded in different ledgers. Send them as two calls.'
				);

			if (reviewDecisions.length) {
				const raw = await store.readFile(repoArgs, REVIEW_LEDGER_PATH);
				let ledger;
				try {
					ledger = parseReviewLedger(raw?.content ?? null);
				} catch {
					return fail(
						`The review ledger (${REVIEW_LEDGER_PATH}) is corrupt. Fix or delete it before recording decisions.`
					);
				}
				const at = todayIso();
				for (const d of reviewDecisions) {
					ledger =
						d.action === 'dismiss'
							? dismissFinding(ledger, d.finding, d.why?.trim() ?? '', at)
							: undismissFinding(ledger, d.finding);
				}
				const head = await store.getHead(repoArgs, config.defaultBranch);
				const dismissed = reviewDecisions.filter((d) => d.action === 'dismiss').length;
				const restored = reviewDecisions.length - dismissed;
				const summary = [
					dismissed ? `${dismissed} dismissed` : '',
					restored ? `${restored} restored` : ''
				]
					.filter(Boolean)
					.join(', ');
				await store.commitOrPR(repoArgs, {
					writeMode: config.writeMode,
					defaultBranch: config.defaultBranch,
					author,
					autoMerge: config.autoMerge,
					mergeMethod: config.mergeMethod,
					message: `Record validate decisions: ${summary}`,
					writes: [{ path: REVIEW_LEDGER_PATH, content: serializeReviewLedger(ledger) }],
					head,
					branchPrefix: 'isomorphic/resolve',
					prTitle: 'Record validate decisions',
					prBody: `${summary}. No page content changed — this records that a human decided, so validate stops re-reporting it.`
				});
				return ok(
					`Recorded: ${summary}. validate will not raise ${dismissed === 1 ? 'it' : 'them'} again unless undismissed.`
				);
			}

			// Every import decision in one call must name the same source, because the
			// ledger it writes is per-source and one commit writes one ledger.
			const sources = [...new Set(importDecisions.map((d) => parseImportKey(d.finding)!.source))];
			if (sources.length > 1)
				return fail(
					`These findings span ${sources.length} import sources (${sources.join(', ')}). Send one call per source.`
				);
			const source = sources[0];
			const decisions = importDecisions.map((d) => ({
				key: parseImportKey(d.finding)!.recordKey,
				action: d.action as 'delete' | 'alias' | 'suppress' | 'recreate',
				alias_to: d.alias_to
			}));

			const badAlias = decisions.find((d) => d.action === 'alias' && !d.alias_to?.trim());
			if (badAlias) return fail(`Decision for "${badAlias.key}": alias needs "alias_to".`);

			await ensureFresh(db, store, repoArgs, brainId, config);
			const allFields = await loadAllFields(db, brainId);

			// Pages the decisions touch: claimants of decided keys + alias targets.
			const decidedKeys = new Set(decisions.map((d) => d.key.trim()));
			const aliasTargets = new Set(
				decisions
					.filter((d) => d.action === 'alias')
					.map((d) => d.alias_to!.trim().replace(/^\/+/, ''))
			);
			const relevant = new Set<string>();
			const keysOf = (fields: Map<string, string[]>) => [
				...(fields.get(SOURCE_KEY_FIELD) ?? []),
				...(fields.get(SOURCE_KEYS_FIELD) ?? [])
			];
			for (const [path, fields] of allFields) {
				if (aliasTargets.has(path) || keysOf(fields).some((k) => decidedKeys.has(k))) {
					relevant.add(path);
				}
			}
			// Alias targets may carry no key claims yet — include them regardless.
			for (const t of aliasTargets) relevant.add(t);

			const head = await store.getHead(repoArgs, config.defaultBranch);
			const tree = await store.listTree(repoArgs, head);
			const { pages } = await store.fetchPages(
				repoArgs,
				tree.filter((e) => relevant.has(e.path))
			);
			const claimed: ClaimedPage[] = pages.map((p) => ({
				path: p.path,
				keys: keysOf(allFields.get(p.path) ?? new Map()),
				content: p.content
			}));

			const ledgerFile = await store.readFile(repoArgs, ledgerPath(source));
			let ledger;
			try {
				ledger = parseLedger(ledgerFile?.content ?? null);
			} catch {
				return fail(`The import ledger (${ledgerPath(source)}) is corrupt — fix it first.`);
			}

			const p = planDecisions({
				decisions: decisions as ImportDecision[],
				claimed,
				ledger
			});

			const summary = p.applied.map((a) => `${a.action} "${a.key}" (${a.detail})`).join('; ');
			const errText = p.errors.length
				? `\n\nNot applied:\n${p.errors.map((e) => `- "${e.key}": ${e.error}`).join('\n')}`
				: '';
			const structured = { source, applied: p.applied, errors: p.errors };
			if (!p.writes.length && !p.deletes.length && !p.applied.length) {
				return fail(`No decisions could be applied.${errText}`);
			}

			const writes = [...p.writes];
			if (serializeLedger(p.ledgerAfter) !== serializeLedger(ledger)) {
				writes.push({ path: ledgerPath(source), content: serializeLedger(p.ledgerAfter) });
			}
			const log = await store.readFile(repoArgs, logPathOf(config));
			if (log) {
				writes.push({
					path: logPathOf(config),
					content: insertLogEntry(
						log.content,
						todayIso(),
						`Resolved import decisions for "${source}": ${p.applied.length} applied.`
					)
				});
			}

			const outcome = await store.commitOrPR(repoArgs, {
				writeMode: config.writeMode,
				defaultBranch: config.defaultBranch,
				author,
				autoMerge: config.autoMerge,
				mergeMethod: config.mergeMethod,
				message: `Resolve import decisions (${source}): ${p.applied.length} applied`,
				writes,
				deletes: p.deletes,
				head,
				branchPrefix: 'isomorphic/import',
				prTitle: `Resolve import decisions (${source})`,
				prBody: `Apply ${p.applied.length} reconciliation decision(s) for source \`${source}\`. Via the Isomorphic brain tools.`
			});

			const landed =
				outcome.prUrl && !outcome.merged
					? outcome.autoMergeEnabled
						? ` It will merge automatically once checks pass: ${outcome.prUrl}`
						: ` Review and merge it here: ${outcome.prUrl}`
					: '';
			return ok(`Applied: ${summary}.${landed}${errText}`, { ...structured, prUrl: outcome.prUrl });
		}
	);
}
