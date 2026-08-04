// Feedback composition: the pure layer behind `submit_feedback` (src/tools/feedback.ts).
//
// Turns what a user said into the exact GitHub issue that will be filed on the
// project's PUBLIC repository. Everything here is deterministic and Worker-safe
// (no octokit, no `node:*`), so `pnpm test:feedback` can pin the two things that
// must not silently regress: what gets redacted, and what the published body says.
//
// THE PRIVACY MODEL, since it is the whole reason this module exists:
//
//   The destination repo is public, so an issue body is world-readable and
//   permanently indexed. So NOTHING identifying is attached to it here. Not the
//   reporter's email, not their user id, not their org, not their brain's repo
//   name. The issue carries only the user's own words plus an opaque report id;
//   the mapping from that id back to the account lives in a private D1 row
//   (`feedback_reports`, migration 0005). A maintainer can always answer "who
//   asked for this?" without the answer being public.
//
//   Redaction below is a NARROW backstop, not the safety mechanism. It matches
//   only shapes that are never legitimately part of a bug report (credentials,
//   PEM blocks, bearer headers, email addresses) and deliberately leaves
//   everything else alone: a scrubber aggressive enough to catch every possible
//   secret also mangles the commit shas, paths, and error text that make a report
//   worth filing. The real backstop is that `submit_feedback` REFUSES to post
//   until the user has been shown the exact title and body (see that tool's
//   confirm gate). Redaction exists to catch the case where someone pastes a token
//   and neither they nor the model notices.

export type FeedbackKind = 'bug' | 'idea' | 'other';

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'other'];

// A title long enough to be useful in a notification email, short enough to read
// in the issue list. Bodies are capped well under GitHub's 65,536 so an issue
// stays reviewable and one caller can't dump a log file into the tracker.
export const MAX_TITLE = 120;
export const MAX_DETAILS = 8000;

// ---------- redaction ----------

// Ordered deliberately: multi-line PEM blocks first (they contain base64 that the
// later patterns would chew into), then header-shaped secrets, then prefixed
// tokens, then JWTs, then emails last (no JWT contains an `@`).
const REDACTIONS: Array<[RegExp, string]> = [
	[/-----BEGIN [^-]*-----[\s\S]*?-----END [^-]*-----/g, '[private key redacted]'],
	[/\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi, 'Bearer [redacted]'],
	// GitHub tokens: ghp_ (classic PAT), gho_/ghu_ (OAuth), ghs_ (App installation),
	// ghr_ (refresh), github_pat_ (fine-grained).
	[/\b(?:gh[opsur]|github_pat)_[A-Za-z0-9_]{16,}/g, '[token redacted]'],
	// Resend (AUTH_RESEND_KEY) and sk- style provider keys.
	[/\bre_[A-Za-z0-9_]{16,}/g, '[token redacted]'],
	[/\bsk-[A-Za-z0-9_-]{16,}/g, '[token redacted]'],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[token redacted]'],
	[/[\w.+-]+@[\w-]+\.[\w.-]*[\w]/g, '[email redacted]']
];

export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
	return out;
}

// ---------- report ids ----------

// Crockford base32 minus the ambiguous letters, so an id survives being read
// aloud on a call or retyped out of a screenshot.
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Pure so the test can pin the format. `newReportId` is the caller-facing wrapper.
export function formatReportId(bytes: Uint8Array): string {
	let id = '';
	for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
	return `ISO-${id}`;
}

export function newReportId(): string {
	return formatReportId(crypto.getRandomValues(new Uint8Array(8)));
}

// ---------- issue composition ----------

export interface FeedbackInput {
	kind: FeedbackKind;
	summary: string;
	details?: string;
}

export interface ComposedIssue {
	title: string;
	body: string;
	labels: string[];
	// True when redaction actually changed something, so the tool can say so in the
	// preview rather than quietly altering the user's words.
	redacted: boolean;
	// True when `details` hit MAX_DETAILS, for the same reason.
	truncated: boolean;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

export function composeIssue(input: FeedbackInput, reportId: string): ComposedIssue {
	const rawSummary = oneLine(input.summary);
	const rawDetails = (input.details ?? '').trim();

	const summary = redact(rawSummary);
	let details = redact(rawDetails);
	const redacted = summary !== rawSummary || details !== rawDetails;

	const truncated = details.length > MAX_DETAILS;
	if (truncated) details = `${details.slice(0, MAX_DETAILS)}\n\n_(truncated)_`;

	const title =
		summary.length > MAX_TITLE ? `${summary.slice(0, MAX_TITLE - 1).trimEnd()}…` : summary;

	// The body leads with the full summary in two cases: the title had to be cut (so
	// nothing the user wrote is lost to truncation), and there are no details at all
	// (where the summary IS the report; otherwise the issue body would be nothing
	// but the footer, which is how this first shipped).
	const opening = title === summary && details ? '' : `${summary}\n\n`;

	const body =
		`${opening}${details}`.trim() +
		'\n\n---\n' +
		`Filed from Claude with \`submit_feedback\`. Report \`${reportId}\`.\n\n` +
		'No account, email, organization, or brain details are published with this report. ' +
		'A maintainer can match the report id to the reporting account privately.\n';

	return { title, body, labels: ['feedback', input.kind], redacted, truncated };
}

// What the user must see BEFORE anything is posted. Public-ness is stated first
// because it is the part they cannot undo.
export function previewText(issue: ComposedIssue, repo: string): string {
	const notes: string[] = [];
	if (issue.redacted)
		notes.push(
			'Something matching a credential or an email address was removed from the text below.'
		);
	if (issue.truncated)
		notes.push(`The details were longer than ${MAX_DETAILS} characters and were cut.`);

	return (
		`This will open a PUBLIC issue on \`${repo}\`. Anyone can read it, and it cannot be truly unpublished.\n\n` +
		`Labels: ${issue.labels.join(', ')}\n\n` +
		`Title:\n${issue.title}\n\n` +
		`Body:\n${issue.body}\n` +
		(notes.length ? `\n${notes.map((n) => `Note: ${n}`).join('\n')}\n` : '') +
		'\nShow the user this exact title and body and get their go-ahead, then call submit_feedback ' +
		'again with the same arguments plus `confirm: true` to post it.'
	);
}
