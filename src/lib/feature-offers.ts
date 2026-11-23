// Features a brain does not use yet, offered by `validate` as one keyed line. An offer is a
// `Finding` (`feature-offer:<id>`), so `resolve` with "dismiss" silences it through the review
// ledger. The key never carries a count or a date, so a dismissal outlives edits. Pure: the
// tool gathers the context and renders the pick.
import { checkDateOf, COMMITMENT_TYPE_RE } from './advisories.ts';
import type { PageFields } from './brain-index.ts';
import { findingKey, isCommitmentKey, type Finding } from './findings.ts';
import { roleAtLeast, type Role } from './orgs.ts';

/** What an entry reads. `pages` are concept pages only. */
export interface OfferContext {
	pages: { path: string }[];
	fields: Map<string, PageFields>;
	/** The brain's `indexedFields` allowlist, or null when every key is indexed. */
	indexedFields: string[] | null;
	/** The caller may write to the brain (editor or above). */
	canEdit: boolean;
	/** A prediction-due or undated-commitment finding is in this run's due area. */
	commitmentFindings: boolean;
	/** A near-duplicate or same-identifier tension was found this run. */
	tension: boolean;
	/** The caller is an admin of the brain's organization. False with no organization. */
	orgAdmin: boolean;
	/** Whether the organization lacks the enterprise entitlement. Read only when asked. */
	lacksEnterprise: () => Promise<boolean>;
}

export interface FeatureOffer {
	id: string;
	edition: 'core' | 'ee';
	/** Tool names the feature is used through. */
	uses: string[];
	applies: (ctx: OfferContext) => boolean;
	/** True when the brain does not use the feature. */
	unused: (ctx: OfferContext) => boolean;
	text: (ctx: OfferContext) => string;
}

/** Whether a finding key is a consolidation tension that evidences the enterprise check. */
export const isTensionEvidenceKey = (key: string): boolean =>
	key.startsWith('near-duplicate:') || key.startsWith('same-identifier:');

/**
 * The context from what `validate` already holds: the caller's roles and the keys of the
 * findings kept this run (after dismissals). `lacksEnterprise` is the one lookup, left to the
 * caller so it runs only when an enterprise entry is the pick.
 */
export function offerContext(input: {
	pages: { path: string }[];
	fields: Map<string, PageFields>;
	indexedFields: string[] | null;
	role: Role;
	orgRole: Role | null | undefined;
	orgId: string | undefined;
	keptKeys: readonly string[];
	lacksEnterprise: () => Promise<boolean>;
}): OfferContext {
	return {
		pages: input.pages,
		fields: input.fields,
		indexedFields: input.indexedFields,
		canEdit: roleAtLeast(input.role, 'editor'),
		commitmentFindings: input.keptKeys.some(isCommitmentKey),
		tension: input.keptKeys.some(isTensionEvidenceKey),
		orgAdmin: !!input.orgId && !!input.orgRole && roleAtLeast(input.orgRole, 'admin'),
		lacksEnterprise: input.lacksEnterprise
	};
}

/** Decisions and commitments, as the page type `undatedCommitmentFindings` reads. */
const commitmentPages = (ctx: OfferContext): string[] =>
	ctx.pages
		.map((p) => p.path)
		.filter((path) => COMMITMENT_TYPE_RE.test(ctx.fields.get(path)?.get('type')?.[0] ?? ''));

const nonEmpty = (values: string[] | undefined): boolean =>
	(values ?? []).some((v) => v.trim() !== '');

export const MIN_COMMITMENT_PAGES = 5;

export const FEATURE_OFFERS: FeatureOffer[] = [
	{
		id: 'commitments',
		edition: 'core',
		uses: ['write_page'],
		applies: (ctx) =>
			!ctx.commitmentFindings &&
			(ctx.indexedFields === null || ctx.indexedFields.includes('check_at')) &&
			commitmentPages(ctx).length >= MIN_COMMITMENT_PAGES,
		unused: (ctx) =>
			commitmentPages(ctx).every((path) => {
				const get = (k: string) => ctx.fields.get(path)?.get(k);
				return (
					!nonEmpty(get('check_at')) && !nonEmpty(get('expected')) && !nonEmpty(get('outcome'))
				);
			}),
		text: (ctx) => {
			const paths = commitmentPages(ctx);
			const dated = paths.filter((path) => checkDateOf((k) => ctx.fields.get(path)?.get(k))).length;
			const undated = paths.length - dated;
			const split = dated
				? `${dated} already have a date validate raises and ${undated} do not`
				: `none has a date validate raises`;
			return (
				`Tell the person: this brain holds ${paths.length} decisions or commitments, ${split}, and none records \`expected\`, ` +
				'so validate cannot ask what happened. ' +
				'Only if yes: ask which of the 3 to 5 most recently updated undated decisions are still waiting on a result, then call write_page with fields `expected` and `check_at` (YYYY-MM-DD) on only those; none waiting counts as no. ' +
				'If no: resolve with dismiss and their reason.'
			);
		}
	},
	{
		id: 'consolidation',
		edition: 'ee',
		uses: ['review_brain'],
		applies: (ctx) => ctx.tension && ctx.orgAdmin,
		unused: () => true,
		text: () =>
			"Tell the person: the enterprise edition can check this brain's pages against each other and the organization's other brains for contradictions. " +
			'Only if yes: ask whoever runs this deployment about turning it on. ' +
			'If no: resolve with dismiss and their reason.'
	}
];

/**
 * The one offer to show, or null. Core entries first; the enterprise tier is read (and its
 * entitlement looked up) only when no core entry is left. `keep` drops dismissed offers, so a
 * dismissal lets the next eligible entry surface.
 */
export async function pickOffer(
	ctx: OfferContext,
	keep: (offers: Finding[]) => Finding[],
	offers: readonly FeatureOffer[] = FEATURE_OFFERS
): Promise<Finding | null> {
	if (!ctx.canEdit) return null;
	for (const edition of ['core', 'ee'] as const) {
		const eligible = offers.filter((o) => o.edition === edition && o.applies(ctx) && o.unused(ctx));
		const found = keep(
			eligible.map((o) => ({
				key: findingKey('feature-offer', o.id),
				weight: 1,
				headline: `- ${o.text(ctx)}`
			}))
		)[0];
		if (!found) continue;
		if (edition === 'ee' && !(await ctx.lacksEnterprise())) continue;
		return found;
	}
	return null;
}
