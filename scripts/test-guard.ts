// Golden test for the data-policy guard in shadow mode. No network: the detectors
// and the store wrapper are pure, config parsing runs over a stub store, and the D1
// half runs the REAL migrations over node:sqlite.
//
//   pnpm test:guard
//
// What this exists to catch:
//
//   1. A DETECTOR THAT CRIES WOLF. Each detector trades recall for precision; the
//      negatives here (phone numbers, dates, commit shas, Luhn-invalid digits,
//      never-issued SSNs, unlabelled ids) are the everyday content of a brain, and
//      a guard that flags them trains everyone to ignore it.
//   2. A DETECTION THAT CARRIES THE SECRET. Detections hold offsets, never text, and
//      the D1 row holds no column that could take the matched value.
//   3. SHADOW MODE COSTING A WRITE. A failing recorder, or a failing write, must
//      behave exactly as the unguarded store would: the write lands, or its own
//      error surfaces, and nothing is recorded for a write that did not land.
//   4. A GUARD THAT IS ON WHEN NOBODY ASKED. Absent, malformed or unknown
//      `review.policy.mode` values mean off, and off returns the store untouched.
//   5. A WRITE PATH THE GUARD MISSES. Both commitOrPR and commitFiles are wrapped,
//      and binary (base64) writes are skipped rather than scanned as text.

import { localD1 } from '../src/local/d1-sqlite.ts';
import type { D1Database } from '@cloudflare/workers-types';
import type { BrainStore, FileWrite } from '../src/lib/brain-repo.ts';
import { detectSensitive, luhn, type DetectionKind } from '../src/lib/policy-detectors.ts';
import { guardStore, scanWrites, type WriteDetection } from '../src/lib/policy-guard.ts';
import { recordDetections, RETENTION_MS } from '../src/lib/policy-store.ts';
import { loadBrainConfig, DEFAULT_BRAIN_CONFIG } from '../src/lib/brain-config.ts';

import { checker } from './check.ts';

const { check, done } = checker('guard checks');

const kinds = (text: string): DetectionKind[] => detectSensitive(text).map((d) => d.kind);

console.log('\ndetectors: true positives');
{
	const cases: [string, string, DetectionKind][] = [
		['Visa, grouped', 'card on file: 4111 1111 1111 1111 exp 04/29', 'card-number'],
		['Amex, ungrouped', 'amex 378282246310005.', 'card-number'],
		['Mastercard, hyphens', '5555-5555-5555-4444', 'card-number'],
		['SSN', 'SSN 123-45-6789 on the intake form', 'us-ssn'],
		['AWS key id', 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE', 'api-token'],
		['GitHub token', `token: ghp_${'a'.repeat(36)}`, 'api-token'],
		['GitHub fine-grained token', `github_pat_${'A1_'.repeat(10)}`, 'api-token'],
		['Slack token', 'xoxb-1234567890-abcdefghij', 'api-token'],
		['secret key', `ANTHROPIC_API_KEY=sk-ant-${'x'.repeat(40)}`, 'api-token'],
		['Stripe live key', `sk_live_${'4'.repeat(24)}`, 'api-token'],
		['Google API key', `AIza${'B'.repeat(35)}`, 'api-token'],
		['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...', 'private-key'],
		['OpenSSH private key', '-----BEGIN OPENSSH PRIVATE KEY-----', 'private-key'],
		['labelled MRN', 'Patient MRN: 00123456 admitted', 'medical-record-number'],
		['spelled-out MRN', 'medical record number #A-99812', 'medical-record-number'],
		['DOB, numeric', 'DOB: 04/12/1981', 'date-of-birth'],
		['date of birth, words', 'date of birth March 3, 1975', 'date-of-birth']
	];
	for (const [label, text, kind] of cases) {
		check(label, kinds(text).includes(kind), JSON.stringify(detectSensitive(text)));
	}
}

console.log('\ndetectors: everyday content is not flagged (1)');
{
	const clean: [string, string][] = [
		['phone number', 'call me at +1 (555) 123-4567 or 555-123-4567'],
		['email', 'reach me at someone@example.com'],
		['ISO date and time', 'met on 2026-09-30 at 12:47:59 CDT'],
		['Luhn-invalid 16 digits', 'order 4111 1111 1111 1112'],
		['repeated digits', '4444444444444444'],
		['a digit run inside a hex sha', 'commit a4111111111111111b3c'],
		['digits inside a longer run', 'id 94111111111111111110'],
		['never-issued SSN areas', '000-12-3456, 666-12-3456, 912-34-5678'],
		['never-issued SSN group and serial', '123-00-4567 and 123-45-0000'],
		['unlabelled record id', 'ticket 00123456 closed'],
		['epoch millis', 'created_at 1759254000000'],
		['short sk- prefix', 'the sk-learn package'],
		['public key', '-----BEGIN PUBLIC KEY-----']
	];
	for (const [label, text] of clean) {
		check(label, detectSensitive(text).length === 0, JSON.stringify(detectSensitive(text)));
	}
	check('Luhn: known-valid', luhn('4111111111111111') && luhn('378282246310005'));
	check('Luhn: known-invalid', !luhn('4111111111111112'));
}

console.log('\ndetectors: offsets, never text (2)');
{
	const text = 'prefix SSN 123-45-6789 suffix';
	const [d] = detectSensitive(text);
	check('offsets bound the match', text.slice(d.start, d.end) === '123-45-6789');
	check(
		'a detection has only kind, severity and offsets',
		JSON.stringify(Object.keys(d).sort()) === JSON.stringify(['end', 'kind', 'severity', 'start'])
	);
	const many = Array.from({ length: 80 }, () => '123-45-6789').join(' ');
	check('capped per text', detectSensitive(many).length === 50);
}

console.log('\nscanWrites: text only, per path (5)');
{
	const writes: FileWrite[] = [
		{ path: 'wiki/a.md', content: 'SSN 123-45-6789' },
		{ path: 'wiki/b.md', content: 'nothing here' },
		{ path: 'wiki/img.png', content: 'MTIzLTQ1LTY3ODk= 123-45-6789', encoding: 'base64' }
	];
	const found = scanWrites(writes);
	check('one detection', found.length === 1, JSON.stringify(found));
	check('attributed to its path', found[0]?.path === 'wiki/a.md');
	check('no writes, no detections', scanWrites(undefined).length === 0);
}

// A stub store: records what reached it, and can be told to fail.
function stubStore(opts: { fail?: boolean } = {}) {
	const calls: string[] = [];
	const store = {
		async commitOrPR() {
			calls.push('commitOrPR');
			if (opts.fail) throw new Error('write failed');
			return { commitSha: 'abc' };
		},
		async commitFiles() {
			calls.push('commitFiles');
			if (opts.fail) throw new Error('write failed');
			return { sha: 'abc', head: { commitSha: 'abc', treeSha: 'def' } };
		}
	} as unknown as BrainStore;
	return { store, calls };
}

const repo = { owner: 'example-org', repo: 'brain' };
const sensitive: FileWrite[] = [{ path: 'wiki/a.md', content: 'SSN 123-45-6789' }];
const commitOpts = {
	writeMode: 'direct' as const,
	defaultBranch: 'main',
	message: 'edit',
	writes: sensitive
};

console.log('\nguardStore: shadow records, never blocks (3, 5)');
{
	const { store, calls } = stubStore();
	const recorded: WriteDetection[][] = [];
	const guarded = guardStore(store, { mode: 'shadow', record: async (d) => void recorded.push(d) });
	const out = await guarded.commitOrPR(repo, commitOpts);
	check('the write reached the store', calls.join() === 'commitOrPR');
	check("the store's result is returned unchanged", out.commitSha === 'abc');
	check(
		'commitOrPR detections recorded',
		recorded.length === 1 && recorded[0][0].kind === 'us-ssn'
	);
	await guarded.commitFiles(repo, { message: 'edit', writes: sensitive });
	check('commitFiles is guarded too', recorded.length === 2);
	await guarded.commitOrPR(repo, {
		...commitOpts,
		writes: [{ path: 'wiki/b.md', content: 'fine' }]
	});
	check('a clean write records nothing', recorded.length === 2);
}
{
	const { store, calls } = stubStore();
	const guarded = guardStore(store, {
		mode: 'shadow',
		record: async () => {
			throw new Error('D1 down');
		}
	});
	let threw = false;
	try {
		await guarded.commitOrPR(repo, commitOpts);
	} catch {
		threw = true;
	}
	check('a failing recorder does not fail the write', !threw && calls.length === 1);
}
{
	const { store } = stubStore({ fail: true });
	const recorded: WriteDetection[][] = [];
	const guarded = guardStore(store, { mode: 'shadow', record: async (d) => void recorded.push(d) });
	let message = '';
	try {
		await guarded.commitOrPR(repo, commitOpts);
	} catch (e) {
		message = (e as Error).message;
	}
	check("a failed write surfaces the store's own error", message === 'write failed');
	check('a failed write records nothing', recorded.length === 0);
}

console.log('\nguardStore and config: off unless asked (4)');
{
	const { store } = stubStore();
	check(
		'off returns the store itself',
		guardStore(store, { mode: 'off', record: async () => {} }) === store
	);
	check('the default config is off', DEFAULT_BRAIN_CONFIG.policyMode === 'off');

	const withConfig = (content: string | null) =>
		({
			async readFile() {
				return content === null ? null : { content, sha: 'x' };
			},
			async repoWritePolicy() {
				return { defaultBranch: 'main', branchProtected: false, mergeMethod: 'MERGE' };
			}
		}) as unknown as BrainStore;
	const modeOf = async (content: string | null) =>
		(await loadBrainConfig(withConfig(content), repo)).policyMode;

	check(
		'shadow when asked',
		(await modeOf('{"review":{"policy":{"mode":"shadow"}}}')) === 'shadow'
	);
	check('absent file: off', (await modeOf(null)) === 'off');
	check('absent key: off', (await modeOf('{"paths":{"wiki/":"content"}}')) === 'off');
	check('unknown mode: off', (await modeOf('{"review":{"policy":{"mode":"enforce"}}}')) === 'off');
	check('malformed file: off', (await modeOf('{not json')) === 'off');
}

console.log('\npolicy_detections: the real migration (2)');
{
	const db = localD1(':memory:').db as unknown as D1Database;
	const now = 1_800_000_000_000;
	const scope = { brainId: 'b1', orgId: 'o1', actorUserId: 'u1', mode: 'shadow' as const };
	await recordDetections(db, scope, scanWrites(sensitive), now);
	const rows = (await db.prepare('SELECT * FROM policy_detections').all()).results as Record<
		string,
		unknown
	>[];
	check('one row per detection', rows.length === 1);
	check(
		'the row records path, kind, offsets and scope',
		rows[0]?.path === 'wiki/a.md' &&
			rows[0]?.kind === 'us-ssn' &&
			rows[0]?.start_offset === 4 &&
			rows[0]?.org_id === 'o1' &&
			rows[0]?.actor_user_id === 'u1' &&
			rows[0]?.mode === 'shadow'
	);
	check(
		'no column holds the matched value',
		!Object.values(rows[0] ?? {}).some((v) => String(v).includes('6789'))
	);

	await recordDetections(db, { ...scope, brainId: 'b2' }, scanWrites(sensitive), now);
	await recordDetections(db, scope, scanWrites(sensitive), now + RETENTION_MS + 1);
	const left = (
		await db.prepare('SELECT brain_id, created_at FROM policy_detections ORDER BY id').all()
	).results as { brain_id: string; created_at: number }[];
	check(
		'expired rows pruned for this brain only',
		left.length === 2 && left[0].brain_id === 'b2' && left[1].created_at === now + RETENTION_MS + 1,
		JSON.stringify(left)
	);
}

done();
