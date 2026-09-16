// Golden test for the feedback composition layer. Pure: no network, no D1.
//
//   pnpm test:feedback
//
// What this exists to catch. `submit_feedback` publishes to a PUBLIC issue
// tracker, so two properties are load-bearing and neither is visible at a glance
// in the diff that breaks it:
//
//   1. Nothing identifying reaches the issue body. The reporter's email, user id,
//      org, and brain live in a private D1 row keyed by an opaque report id
//      (migration 0005). A well-meaning "include the reporter so we can follow up"
//      edit to composeIssue would publish a customer's address permanently, and
//      would look like an improvement in review.
//   2. Credential shapes pasted into a report get redacted, and the redaction
//      leaves ordinary bug-report text (commit shas, paths, error output) alone.
//      A scrubber that mangles those makes reports useless and gets removed.

import {
	composeIssue,
	formatReportId,
	previewText,
	redact,
	MAX_DETAILS,
	MAX_TITLE
} from '../src/lib/feedback.ts';

import { checker } from './check.ts';

const { check, done } = checker('feedback checks');

console.log('\nredaction: credential shapes are removed');
{
	const cases: Array<[string, string]> = [
		['classic PAT', 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
		['fine-grained PAT', 'github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'],
		['installation token', 'ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'],
		['resend key', 're_ABCdefGHIjklMNOpqrSTU123'],
		['sk- provider key', 'sk-ABCdefGHIjklMNOpqrSTUvwx1234567890'],
		[
			'jwt',
			'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
		]
	];
	for (const [label, text] of cases) {
		const out = redact(text);
		check(label, out.includes('[token redacted]') && !out.includes('ABC'), out);
	}

	check(
		'bearer header',
		redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345') ===
			'Authorization: Bearer [redacted]'
	);

	const pem = redact(
		'-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----'
	);
	check('PEM block', pem === '[private key redacted]', pem);

	check(
		'email address',
		redact('reach me at jane.doe+tag@example.co.uk please') ===
			'reach me at [email redacted] please'
	);
}

console.log('\nredaction: ordinary bug-report text survives intact');
{
	// Each of these is the kind of detail that makes a report actionable. A
	// scrubber that eats them is worse than no scrubber.
	const kept = [
		'broke in commit 4b1a5630ac9f1e2d3b4c5d6e7f8091a2b3c4d5e6',
		'wiki/vendors/index.md renders an empty okf-view table',
		'GET /mcp returned 405 Method Not Allowed',
		'the error was "anchor matched 0 times" from page-patch',
		'happens at https://example.com/docs#section-3',
		'D1_ERROR: no such column: schema_version'
	];
	for (const text of kept) {
		check(text.slice(0, 44), redact(text) === text, redact(text));
	}
}

console.log('\ncomposed issue: nothing identifying is published');
{
	const issue = composeIssue(
		{
			kind: 'bug',
			summary: 'Editor drops the last line of a page on save',
			details: 'Reported by ada@acme-holdings.example while editing acme-holdings/brain-ada.'
		},
		'ISO-TESTTEST'
	);
	const body = issue.body;

	check('the reporter email is not in the body', !body.includes('ada@acme-holdings.example'), body);
	check('an email that was present is redacted', body.includes('[email redacted]'));
	check('redaction is reported to the caller', issue.redacted);
	check('the report id IS in the body', body.includes('ISO-TESTTEST'));
	check('the body says identity is not published', /no account, email/i.test(body));
	check('labels carry the kind', issue.labels.join(',') === 'feedback,bug');
	check('title is the summary', issue.title === 'Editor drops the last line of a page on save');

	// The composer takes no identity argument at all, which is the structural
	// version of property 1: there is nothing there to leak.
	check(
		'composeIssue takes only (input, reportId)',
		composeIssue.length === 2,
		`arity ${composeIssue.length}`
	);
}

console.log('\ncomposed issue: sizes and shapes');
{
	const long = 'x'.repeat(400);
	const issue = composeIssue({ kind: 'idea', summary: long }, 'ISO-1');
	check('title is capped', issue.title.length <= MAX_TITLE, `${issue.title.length}`);
	check('a cut summary is preserved in the body', issue.body.includes(long));

	const big = composeIssue(
		{ kind: 'other', summary: 'huge log', details: 'y'.repeat(MAX_DETAILS + 500) },
		'ISO-2'
	);
	check('oversized details are truncated', big.truncated);
	check('truncation is marked in the body', big.body.includes('_(truncated)_'));
	check('body stays bounded', big.body.length < MAX_DETAILS + 600, `${big.body.length}`);

	const multiline = composeIssue({ kind: 'bug', summary: '  spans\n  two   lines  ' }, 'ISO-3');
	check('summary is collapsed to one line', multiline.title === 'spans two lines', multiline.title);

	// A summary-only report is the common case ("dark mode please"), and its body
	// must actually say the thing rather than being a bare footer.
	const noDetails = composeIssue({ kind: 'idea', summary: 'add dark mode' }, 'ISO-4');
	check(
		'a details-free report states the summary in the body',
		noDetails.body.startsWith('add dark mode'),
		noDetails.body
	);
	check('nothing is truncated or redacted', !noDetails.truncated && !noDetails.redacted);
}

console.log('\nreport ids');
{
	const id = formatReportId(new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]));
	check('deterministic format', id === 'ISO-0123TVWX', id);
	check('prefixed and fixed length', /^ISO-[0-9A-HJKMNP-TV-Z]{8}$/.test(id), id);
	// The whole alphabet, exercised via bytes 0..31. Checked past the `ISO-` prefix,
	// which contains I, S, and O by design.
	const wholeAlphabet = formatReportId(
		new Uint8Array(Array.from({ length: 32 }, (_, i) => i))
	).slice(4);
	check('no ambiguous letters (I, L, O, U)', !/[ILOU]/.test(wholeAlphabet), wholeAlphabet);
}

console.log('\npreview: the confirm gate tells the user what it will do');
{
	const issue = composeIssue({ kind: 'bug', summary: 'thing is broken' }, 'ISO-5');
	const preview = previewText(issue, 'example-org/example-app');
	check('says it will be public', /PUBLIC/.test(preview));
	check('names the destination repo', preview.includes('example-org/example-app'));
	check(
		'shows the exact title and body',
		preview.includes(issue.title) && preview.includes(issue.body)
	);
	check('tells the model how to actually post', /confirm: true/.test(preview));

	const redactedPreview = previewText(
		composeIssue(
			{ kind: 'bug', summary: 'broke', details: 'key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
			'ISO-6'
		),
		'example-org/example-app'
	);
	check(
		'warns when text was altered',
		/Note: Something matching a credential/.test(redactedPreview)
	);
}

done();
