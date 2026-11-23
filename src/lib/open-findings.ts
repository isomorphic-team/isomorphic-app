// What is open in a brain: the one assembly of the advisory findings, the stored queue, the due
// area, the other-dates block and the feature offer. `validate` formats it with `renderOpenFindings`;
// the structured fields are for any other surface that lists what is open.
// Reads the index, the store and D1 through the arguments, never a tool context.
import type { D1Database } from '@cloudflare/workers-types';
import {
	ambiguousTitleSuggestions,
	comingDueLines,
	dueBlock,
	folderNoteSuggestions,
	inlinedConceptSuggestions,
	MAX_FINDINGS_SHOWN,
	otherDueBlock,
	otherDueLines,
	predictionDueFindings,
	typeFieldSuggestions,
	undatedCommitmentFindings,
	wikilinkPortabilityNote
} from './advisories.ts';
import type { BrainStore, BrainLocator } from './brain-repo.ts';
import { isContentPath, isToolMaintained, type BrainConfig } from './brain-config.ts';
import type { BrainIndex, ResolvedGraph } from './brain-index.ts';
import { parseLedger } from './brain-import.ts';
import { computeTensions, MAX_DUP_PAGES, tensionFindings } from './consolidate.ts';
import { FEATURES, hasFeature } from './entitlements.ts';
import { offerContext, pickOffer } from './feature-offers.ts';
import {
	filterDismissed,
	importFindings,
	parseReviewLedger,
	renderFindings,
	renderValidateFindings,
	partitionCommitments,
	REVIEW_LEDGER_PATH,
	type Finding,
	type ReviewLedger
} from './findings.ts';
import type { Role } from './orgs.ts';
import {
	clusterFindings,
	isPolicyKey,
	otherBrainIds,
	queueReport,
	readReconciledFindings,
	staleNote,
	type ReachableBrain
} from './review-queue.ts';
import { isFolderNoteName } from './view-directives.ts';
import { todayIso } from './wiki.ts';

/** Pending import findings and the lines `validate` prints about them. */
export interface ImportLedgers {
	findings: Finding[];
	notes: string[];
}

export interface OpenFindingsInput {
	store: BrainStore;
	locator: BrainLocator;
	config: BrainConfig;
	db: D1Database;
	brainId: string;
	index: BrainIndex;
	graph: ResolvedGraph;
	role: Role;
	actorUserId: string | undefined;
	orgId: string | undefined;
	orgRole: Role | null | undefined;
	policySecret: string | undefined;
	/** The other brains the stored queue quotes, as far as the caller can open them. */
	/** The caller's own `readImportLedgers`, when it needs the notes even if this throws. */
	imports?: ImportLedgers;
	reachable: (brainIds: readonly string[]) => Promise<Map<string, ReachableBrain>>;
}

export interface OpenFindings {
	/** The due area: commitment findings (prediction-due, undated-commitment), then the unkeyed coming-due lines. */
	due: { commitments: Finding[]; coming: string[] };
	/** The kept findings validate lists, clustered, apart from the commitments above. */
	findings: { list: Finding[]; silenced: number; staleCount: number };
	/** Dates under other deadline-named keys, nearest first, at most `MAX_OTHER_DUE_LINES`. */
	otherDates: string[];
	/** One line per source with import decisions pending, and per unreadable import ledger. */
	importNotes: string[];
	/** The one feature offer, or null. */
	offer: Finding | null;
	/** Open policy findings, for the admin section. */
	openPolicy: number;
}

/** The two texts `validate` prints for an `OpenFindings`; the one place it is formatted. */
export function renderOpenFindings(open: OpenFindings): {
	findingsText: string;
	comingDueText: string;
} {
	const rendered = renderValidateFindings(
		[...open.due.commitments, ...open.findings.list],
		open.findings.silenced,
		MAX_FINDINGS_SHOWN
	);
	return {
		findingsText: rendered.list + staleNote(open.findings.staleCount),
		comingDueText:
			dueBlock(rendered.due, open.due.coming) +
			(open.offer ? `\n\n${renderFindings([open.offer], 1).text}` : '') +
			otherDueBlock(open.otherDates)
	};
}

/**
 * Pending import decisions: each source's unanswered questions, persisted in its ledger
 * (`.isomorphic/imports/<source>.json`) until someone answers them with `resolve`. Best-effort:
 * a failed read costs this part only.
 */
export async function readImportLedgers(
	store: BrainStore,
	locator: BrainLocator,
	config: BrainConfig
): Promise<ImportLedgers> {
	const findings: Finding[] = [];
	const notes: string[] = [];
	try {
		const rev = await store.getRevision(locator, config.defaultBranch);
		// listTree defaults to .md; ledgers are .json.
		const tree = await store.listTree(locator, rev, { extension: '.json' });
		const ledgers = tree.filter((e) => /^\.isomorphic\/imports\/[^/]+\.json$/.test(e.path));
		for (const entry of ledgers) {
			const source = entry.path
				.split('/')
				.pop()!
				.replace(/\.json$/, '');
			const file = await store.readFile(locator, entry.path);
			let ledger;
			try {
				ledger = parseLedger(file?.content ?? null);
			} catch {
				notes.push(
					`Import ledger for "${source}" is corrupt (${entry.path}) — fix it before the next sync.`
				);
				continue;
			}
			if (!ledger.pending.length) continue;
			findings.push(...importFindings(source, ledger.pending));
			notes.push(`${ledger.pending.length} import decision(s) pending for "${source}".`);
		}
	} catch {
		// Surfacing pending questions is best-effort; link validation stands alone.
	}
	return { findings, notes };
}

export async function openFindings(input: OpenFindingsInput): Promise<OpenFindings> {
	const { store, locator, config, index, graph: resolved } = input;
	const imports = input.imports ?? (await readImportLedgers(store, locator, config));
	const notePaths = resolved.pages
		.filter((p) => isFolderNoteName(p.path.slice(p.path.lastIndexOf('/') + 1)))
		.map((p) => p.path);
	const noteContents = await index.pageContents(notePaths);
	const fieldsByPath = await index.allFields();
	const conceptPages = resolved.pages.filter(
		(p) =>
			!isFolderNoteName(p.path.slice(p.path.lastIndexOf('/') + 1)) &&
			!isToolMaintained(p.path, config)
	);

	// Tension detection needs page bodies only for near-duplicates, and loading a whole brain's
	// content is the expensive step, so above the cap that check is skipped.
	const contents =
		resolved.pages.length <= MAX_DUP_PAGES
			? await index.pageContents(resolved.pages.map((p) => p.path))
			: undefined;

	// An unreadable queue costs this block, not the report.
	let queued: { open: Finding[]; stale: Finding[] } = { open: [], stale: [] };
	const rows = await readReconciledFindings({
		db: input.db,
		store,
		repo: locator,
		defaultBranch: config.defaultBranch,
		brainId: input.brainId,
		secret: input.policySecret
	}).catch(() => []);
	if (rows.length) {
		queued = queueReport(
			rows,
			await index.pageShas(),
			{ role: input.role, userId: input.actorUserId },
			await input.reachable(otherBrainIds(rows))
		);
	}

	const all: Finding[] = [
		...imports.findings,
		...queued.open,
		...inlinedConceptSuggestions(
			[...noteContents].map(([path, content]) => ({ path, content })),
			resolved.pages
		),
		...typeFieldSuggestions(conceptPages, fieldsByPath),
		...predictionDueFindings(conceptPages, fieldsByPath, todayIso()),
		...undatedCommitmentFindings(conceptPages, fieldsByPath),
		...ambiguousTitleSuggestions(resolved.pages),
		...wikilinkPortabilityNote(resolved.edges),
		...folderNoteSuggestions(resolved.pages),
		...tensionFindings(
			computeTensions({
				pages: resolved.pages,
				edges: resolved.edges,
				contents,
				toolMaintained: (p) => isToolMaintained(p, config),
				fields: fieldsByPath,
				identityFields: config.identityFields,
				isContent: (p) => isContentPath(p, config)
			})
		)
	];

	// Everything already decided about is dropped. A corrupt or unreadable ledger filters
	// nothing rather than costing the caller the report.
	let kept = all;
	let keptStale = queued.stale;
	let ledger: ReviewLedger | null = null;
	try {
		const raw = await store.readFile(locator, REVIEW_LEDGER_PATH);
		ledger = parseReviewLedger(raw?.content ?? null);
		kept = filterDismissed(all, ledger);
		keptStale = filterDismissed(queued.stale, ledger);
	} catch {
		// An unparseable ledger filters nothing rather than failing the read.
	}

	const { commitments, rest } = partitionCommitments(clusterFindings(kept));
	const coming = comingDueLines(conceptPages, fieldsByPath, todayIso());
	// One offer for a feature the brain does not use, right after the due area. It is not in
	// `all`, so it never counts in the findings intro or the cap.
	const offer = await pickOffer(
		offerContext({
			pages: conceptPages,
			fields: fieldsByPath,
			indexedFields: config.indexedFields,
			role: input.role,
			orgRole: input.orgRole,
			orgId: input.orgId,
			keptKeys: kept.map((f) => f.key),
			lacksEnterprise: async () =>
				!(input.orgId && (await hasFeature(input.db, input.orgId, FEATURES.enterprise)))
		}),
		(offers) => (ledger ? filterDismissed(offers, ledger) : offers)
	);
	return {
		due: { commitments, coming },
		findings: { list: rest, silenced: all.length - kept.length, staleCount: keptStale.length },
		otherDates: otherDueLines(conceptPages, fieldsByPath, todayIso()),
		importNotes: imports.notes,
		offer,
		openPolicy: kept.filter((f) => isPolicyKey(f.key)).length
	};
}
