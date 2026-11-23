// What is open in a brain: the one assembly of the advisory findings, the stored queue, the due
// area, the other-dates block and the feature offer. `validate` renders `findingsText` and
// `comingDueText` from it; the structured fields are for any other surface that lists what is open.
// Reads the index, the store and D1 through the arguments, never a tool context.
import type { D1Database } from '@cloudflare/workers-types';
import {
	ambiguousTitleSuggestions,
	comingDueLines,
	dueBlock,
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
import { computeTensions, MAX_DUP_PAGES, tensionFindings } from './consolidate.ts';
import { FEATURES, hasFeature } from './entitlements.ts';
import { offerContext, pickOffer } from './feature-offers.ts';
import {
	filterDismissed,
	parseReviewLedger,
	renderFindings,
	renderValidateFindings,
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
	/** Pending import decisions and folder-note suggestions, gathered by the caller. */
	importFindings: Finding[];
	folderNotes: Finding[];
	/** The other brains the stored queue quotes, as far as the caller can open them. */
	reachable: (brainIds: readonly string[]) => Promise<Map<string, ReachableBrain>>;
}

export interface OpenFindings {
	/** Every finding raised this run, before dismissals. */
	all: Finding[];
	/** Those not dismissed. */
	kept: Finding[];
	/** Stored findings whose pages changed since, only counted. */
	staleCount: number;
	/** The list under the due area, with the stale note. */
	findingsText: string;
	/** The due area, the feature offer and the other-dates block. */
	comingDueText: string;
	/** The one feature offer, or null. */
	offer: Finding | null;
	/** Open policy findings, for the admin section. */
	openPolicy: number;
}

export async function openFindings(input: OpenFindingsInput): Promise<OpenFindings> {
	const { store, locator, config, index, graph: resolved } = input;
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
		...input.importFindings,
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
		...input.folderNotes,
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

	// Commitment findings render in the due area, capped apart from the rest, so a full report
	// of housekeeping cannot hide them.
	const rendered = renderValidateFindings(
		clusterFindings(kept),
		all.length - kept.length,
		MAX_FINDINGS_SHOWN
	);
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
		all,
		kept,
		staleCount: keptStale.length,
		findingsText: rendered.list + staleNote(keptStale.length),
		comingDueText:
			dueBlock(rendered.due, coming) +
			(offer ? `\n\n${renderFindings([offer], 1).text}` : '') +
			otherDueBlock(otherDueLines(conceptPages, fieldsByPath, todayIso())),
		offer,
		openPolicy: kept.filter((f) => isPolicyKey(f.key)).length
	};
}
