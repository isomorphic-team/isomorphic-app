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
//   4. A GUARD THAT IS OFF WHEN NOBODY ASKED. It is on by default and never blocks;
//      only an explicit `"off"` turns it off, and off returns the store untouched.
//   5. A WRITE PATH THE GUARD MISSES. Both commitOrPR and commitFiles are wrapped,
//      and binary (base64) writes are skipped rather than scanned as text.
//   6. THE REPORT REACHING THE WRONG PERSON. `validate` shows detections to brain
//      admins only, since even "wiki/intake.md: us-ssn" says where sensitive data
//      sits, and it lists kinds and counts, never values.
//   7. A REPORT THAT READS AS CLEAN ON PARTIAL COVERAGE. Every admin report states what
//      it has seen, and an empty one never implies an empty brain.
//   8. A BASELINE FINDING THAT AGES OUT. A scan's rows outlive the report window and
//      the retention prune, because the content is still there; a repeated step
//      cannot double-count; and a scan is resumable from its cursor.

import { localD1 } from '../src/local/d1-sqlite.ts';
import type { D1Database } from '@cloudflare/workers-types';
import type { BrainStore, FileWrite } from '../src/lib/brain-repo.ts';
import { detectSensitive, luhn, type DetectionKind } from '../src/lib/policy-detectors.ts';
import {
	guardStore,
	guardCoverage,
	scanWrites,
	detectionSection,
	groupDetections,
	reviewSummary,
	MAX_REPORT_PATHS,
	type WriteDetection
} from '../src/lib/policy-guard.ts';
import {
	recordDetections,
	readBaseline,
	readCoverage,
	readDetectionCounts,
	RETENTION_MS
} from '../src/lib/policy-store.ts';
import {
	advanceBaseline,
	baselineStepText,
	planBaselineStep,
	BASELINE_FILE_BUDGET
} from '../src/lib/policy-baseline.ts';
import { loadBrainConfig, DEFAULT_BRAIN_CONFIG } from '../src/lib/brain-config.ts';

import { checker } from './check.ts';

const { check, done } = checker('guard checks');

const kinds = (text: string): DetectionKind[] => detectSensitive(text).map((d) => d.kind);

// A Luhn-valid number of `length` digits starting with `prefix`.
function card(prefix: string, length: number): string {
	const body = prefix.padEnd(length - 1, '7');
	for (let c = 0; c < 10; c++) if (luhn(`${body}${c}`)) return `${body}${c}`;
	throw new Error('unreachable');
}

console.log('\ndetectors: true positives');
{
	const cases: [string, string, DetectionKind][] = [
		['Visa, grouped', 'card on file: 4111 1111 1111 1111 exp 04/29', 'card-number'],
		['Amex, ungrouped', 'amex 378282246310005.', 'card-number'],
		['Mastercard, hyphens', '5555-5555-5555-4444', 'card-number'],
		['Mastercard 2-series', card('2221', 16), 'card-number'],
		['Mastercard 2-series, top of range', card('2720', 16), 'card-number'],
		['Visa, 13 digits', card('4', 13), 'card-number'],
		['Discover', card('6011', 16), 'card-number'],
		['Discover, 644 range', card('644', 16), 'card-number'],
		['JCB', card('3530', 16), 'card-number'],
		['Diners', card('3056', 14), 'card-number'],
		['postgres URI', 'postgres://app:s3cr3tValue@db.internal:5432/app', 'connection-string'],
		['redis URI, no user', 'redis://:s3cr3tValue@cache:6379', 'connection-string'],
		['mongodb+srv URI', 'mongodb+srv://svc:Tr0ub4dor@cluster.mongodb.net', 'connection-string'],
		['https basic auth', 'https://deploy:hunter2x@registry.example.com/x', 'connection-string'],
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
		['public key', '-----BEGIN PUBLIC KEY-----'],
		['Luhn-valid, no network prefix', card('6100', 16)],
		['Luhn-valid, 56 is not Mastercard', card('5600', 16)],
		['Luhn-valid, below the 2-series', card('2220', 16)],
		['Luhn-valid, above the 2-series', card('2721', 16)],
		['Visa prefix, wrong length', card('4', 15)],
		['Amex prefix, wrong length', card('3782', 16)],
		['Mastercard prefix, wrong length', card('51', 15)],
		['Diners prefix, wrong length', card('3056', 16)],
		['URI with a user and no password', 'postgres://app@db.internal:5432/app'],
		['URI with a port only', 'https://example.com:8443/path'],
		['git over ssh', 'ssh://git@github.com:22/acme/repo.git'],
		['password placeholder in angle brackets', 'postgres://app:<password>@db:5432/app'],
		['password placeholder, env style', 'postgres://app:${PASSWORD}@db:5432/app'],
		['password placeholder, bare env', 'postgres://app:$DB_PASSWORD@db:5432/app'],
		['password placeholder, mustache', 'postgres://app:{{password}}@db:5432/app'],
		['password placeholder, brackets', 'mysql://root:[password]@db/app'],
		['password placeholder, word', 'postgres://user:password@localhost/app'],
		['password placeholder, your_password', 'postgres://user:your_password@host/app'],
		['password placeholder, stars', 'postgres://user:****@host/app'],
		['password placeholder, printf', 'postgres://user:%s@host/app']
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

console.log('\nguardStore and config: on unless turned off (4)');
{
	const { store } = stubStore();
	check(
		'off returns the store itself',
		guardStore(store, { mode: 'off', record: async () => {} }) === store
	);
	check('the default config is on (shadow)', DEFAULT_BRAIN_CONFIG.policyMode === 'shadow');

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

	check('off when asked', (await modeOf('{"review":{"policy":{"mode":"off"}}}')) === 'off');
	check('absent file: on', (await modeOf(null)) === 'shadow');
	check('absent key: on', (await modeOf('{"paths":{"wiki/":"content"}}')) === 'shadow');
	check(
		'a typo does not turn it off',
		(await modeOf('{"review":{"policy":{"mode":"of"}}}')) === 'shadow'
	);
	check('malformed file: on', (await modeOf('{not json')) === 'shadow');
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

console.log('\nvalidate report: admins only, kinds and counts (6)');
{
	const db = localD1(':memory:').db as unknown as D1Database;
	const now = 1_800_000_000_000;
	const scope = { brainId: 'b1', mode: 'shadow' as const };
	const twoKinds: FileWrite[] = [
		{ path: 'wiki/intake.md', content: 'SSN 123-45-6789, SSN 234-56-7890, DOB: 04/12/1981' },
		{ path: 'wiki/setup.md', content: 'AKIAIOSFODNN7EXAMPLE' }
	];
	await recordDetections(db, scope, scanWrites(twoKinds), now - 40 * 86_400_000);
	await recordDetections(db, scope, scanWrites(twoKinds), now);
	await recordDetections(db, { ...scope, brainId: 'b2' }, scanWrites(twoKinds), now);
	const counts = await readDetectionCounts(db, 'b1', now - 30 * 86_400_000);
	const ssn = counts.find((c) => c.path === 'wiki/intake.md' && c.kind === 'us-ssn');
	check(
		'counts are per path and kind, inside the window, this brain only',
		ssn?.count === 2 && counts.length === 3,
		JSON.stringify(counts)
	);

	const coverage = guardCoverage('shadow', '2026-10-01 00:00:00', null);
	const text = detectionSection('admin', counts, coverage);
	check(
		'an admin sees the section',
		text.includes('shown to admins only') && text.includes('4 detection(s) across 2 page(s)'),
		text
	);
	check(
		'the busiest page first, kinds by count',
		text.includes('- wiki/intake.md: 2 us-ssn, 1 date-of-birth\n- wiki/setup.md: 1 api-token'),
		text
	);
	check('an owner sees it too', detectionSection('owner', counts, coverage) === text);
	check('an editor sees nothing', detectionSection('editor', counts, coverage) === '');
	check('a viewer sees nothing', detectionSection('viewer', counts, coverage) === '');
	check('the report states its coverage (7)', text.includes(coverage.text));
	const empty = detectionSection('admin', [], coverage);
	check(
		'nothing recorded still states coverage, and never says clean (7)',
		empty.includes('nothing recorded') &&
			empty.includes('has not been scanned') &&
			!/clean/i.test(empty),
		empty
	);
	check(
		'nothing recorded, an editor still sees nothing',
		!detectionSection('editor', [], coverage)
	);
	check('no value appears', !text.includes('6789') && !text.includes('AKIA'));

	const many = Array.from({ length: MAX_REPORT_PATHS + 3 }, (_, i) => ({
		path: `wiki/p${i}.md`,
		kind: 'us-ssn',
		count: 1
	}));
	const capped = detectionSection('admin', many, coverage);
	check(
		'long lists are capped',
		capped.includes('- and 3 more page(s)') &&
			capped.split('\n- wiki/').length === MAX_REPORT_PATHS + 1,
		capped
	);
}

console.log('\ncoverage: what the report has looked at (7)');
{
	const state = (over = {}) => ({
		status: 'done' as const,
		cursor: 'z',
		filesScanned: 40,
		filesSkipped: 2,
		detections: 1,
		startedAt: 0,
		finishedAt: Date.UTC(2026, 9, 20),
		...over
	});
	check(
		'an old brain is covered only from the first release of the guard',
		guardCoverage('shadow', '2026-01-01 09:00:00', null).since === '2026-09-30'
	);
	check(
		'a newer brain is covered from its own date',
		guardCoverage('shadow', '2026-10-15 09:00:00', null).since === '2026-10-15'
	);
	check(
		'an unknown brain date falls back to the first release',
		guardCoverage('shadow', null, null).since === '2026-09-30'
	);
	const none = guardCoverage('shadow', null, null);
	check(
		'no scan: says so, and says pushes are unseen',
		none.baseline === 'none' &&
			none.text.includes('has not been scanned') &&
			none.text.includes('pushed directly'),
		none.text
	);
	const running = guardCoverage('shadow', null, state({ status: 'running', finishedAt: null }));
	check(
		'an unfinished scan is not a scanned brain',
		running.baseline === 'running' &&
			running.text.includes('unfinished') &&
			!running.text.includes('was scanned'),
		running.text
	);
	const done = guardCoverage('shadow', null, state());
	check(
		'a finished scan gives its date and counts the binaries it skipped',
		done.baseline === 'done' &&
			done.text.includes('scanned on 2026-10-20') &&
			done.text.includes('2 binary file(s) skipped'),
		done.text
	);
	check(
		'checks off does not claim to cover writes',
		guardCoverage('off', null, null).text.includes('not scanned') &&
			!guardCoverage('off', null, null).text.includes('since')
	);
}

console.log('\nplanBaselineStep: a budgeted window (8)');
{
	const e = (path: string) => ({ path, sha: path });
	const tree = [e('c.md'), e('a.md'), e('b.png'), e('d.env')];
	const first = planBaselineStep(tree, null, 2);
	check(
		'sorted, windowed, binaries passed over',
		first.read.map((x) => x.path).join() === 'a.md' &&
			first.skipped === 1 &&
			first.last === 'b.png' &&
			!first.done,
		JSON.stringify(first)
	);
	const second = planBaselineStep(tree, first.last, 2);
	check(
		'resumes after the cursor and finishes',
		second.read.map((x) => x.path).join() === 'c.md,d.env' && second.done
	);
	const third = planBaselineStep(tree, 'z', 2);
	check('nothing left is done, and keeps the cursor', third.done && third.last === 'z');
	check('an empty tree is done', planBaselineStep([], null, 2).done);
}

console.log('\nbaseline scan: the real migrations, a stub store (8)');
{
	const db = localD1(':memory:').db as unknown as D1Database;
	const files: Record<string, string> = {
		'wiki/intake.md': 'SSN 123-45-6789',
		'wiki/clean.md': 'nothing here',
		'.env': 'DATABASE_URL=postgres://app:s3cr3tValue@db:5432/app',
		'wiki/photo.png': 'SSN 123-45-6789',
		'wiki/unknown.dat': 'binary, no text from the store',
		'zz-last.md': 'SSN 123-45-6789'
	};
	const store = {
		getHead: async () => ({ commitSha: 'h', treeSha: 't' }),
		listTree: async () => Object.keys(files).map((path) => ({ path, sha: path })),
		fetchPages: async (_r: unknown, entries: { path: string }[]) => ({
			pages: entries
				.filter((e) => !e.path.endsWith('.dat'))
				.map((e) => ({ path: e.path, content: files[e.path] })),
			truncated: false
		})
	} as unknown as BrainStore;
	const target = {
		db,
		store,
		repo: { owner: 'o', repo: 'r' },
		config: DEFAULT_BRAIN_CONFIG,
		scope: { brainId: 'b1', orgId: 'o1', actorUserId: 'u1' }
	};
	const now = Date.now();
	check('no scan yet', (await readBaseline(db, 'b1')) === null);
	const done = await advanceBaseline(target, now);
	check(
		'one call finishes a small brain, every text file read, dotfiles included',
		done.status === 'done' && done.filesScanned === 4 && done.filesSkipped === 2,
		JSON.stringify(done)
	);
	check(
		'the reply says finished',
		baselineStepText(done).includes('finished') && !baselineStepText(done).includes('6789')
	);
	const rows = (await db.prepare('SELECT * FROM policy_detections').all()).results as Record<
		string,
		unknown
	>[];
	check(
		'rows carry baseline mode and no value',
		rows.length === 3 &&
			rows.every((r) => r.mode === 'baseline') &&
			!JSON.stringify(rows).includes('s3cr3t') &&
			!JSON.stringify(rows).includes('6789'),
		JSON.stringify(rows)
	);

	const later = now + 200 * 86_400_000;
	await recordDetections(
		db,
		{ brainId: 'b1', mode: 'shadow' },
		[{ path: 'wiki/new.md', kind: 'us-ssn', severity: 'high', start: 0, end: 1 }],
		later
	);
	const counts = await readDetectionCounts(db, 'b1', later - 30 * 86_400_000);
	check(
		'a baseline finding outlives the report window and the retention prune',
		counts.length === 4 && counts.some((c) => c.path === '.env'),
		JSON.stringify(counts)
	);
	const coverage = await readCoverage(db, 'b1', 'shadow');
	check('coverage reads the finished scan', coverage.baseline === 'done');

	const again = await advanceBaseline(target, later);
	const after = (
		await db.prepare("SELECT path FROM policy_detections WHERE mode = 'baseline'").all()
	).results;
	check(
		'asking again replaces the last scan rather than adding to it',
		again.detections === 3 && after.length === 3,
		JSON.stringify(after)
	);

	files['.env'] = 'clean now';
	delete files['zz-last.md'];
	await advanceBaseline(target, later + 1);
	const fixed = await readDetectionCounts(db, 'b1', later);
	check(
		'a fixed file leaves the report at the next scan',
		!fixed.some((c) => c.path === '.env'),
		JSON.stringify(fixed)
	);
	check(
		'so does a deleted file, past the end of the new tree',
		!fixed.some((c) => c.path === 'zz-last.md'),
		JSON.stringify(fixed)
	);

	const big: Record<string, string> = {};
	for (let i = 0; i < BASELINE_FILE_BUDGET + 5; i++) {
		big[`wiki/p${String(i).padStart(4, '0')}.md`] = 'SSN 123-45-6789';
	}
	const bigTarget = {
		...target,
		scope: { brainId: 'b2' },
		store: {
			...store,
			listTree: async () => Object.keys(big).map((path) => ({ path, sha: path })),
			fetchPages: async (_r: unknown, entries: { path: string }[]) => ({
				pages: entries.map((e) => ({ path: e.path, content: big[e.path] })),
				truncated: false
			})
		} as unknown as BrainStore
	};
	const one = await advanceBaseline(bigTarget, now);
	check(
		'a large brain stops at the budget, unfinished',
		one.status === 'running' && one.filesScanned === BASELINE_FILE_BUDGET,
		JSON.stringify(one)
	);
	const stillPartial = await readCoverage(db, 'b2', 'shadow');
	check('coverage does not call it scanned yet', stillPartial.baseline === 'running');

	// A step whose reply was lost: its rows landed, the cursor did not move.
	await db
		.prepare(
			'UPDATE policy_baseline SET cursor = NULL, files_scanned = 0, detections = 0 WHERE brain_id = ?1'
		)
		.bind('b2')
		.run();
	await advanceBaseline(bigTarget, now);
	const two = await advanceBaseline(bigTarget, now);
	const total = await db
		.prepare("SELECT COUNT(*) AS n FROM policy_detections WHERE brain_id = 'b2'")
		.first<{ n: number }>();
	check(
		'a repeated step does not double-count, and the next one finishes',
		two.status === 'done' && total?.n === BASELINE_FILE_BUDGET + 5 && two.filesScanned === total.n,
		JSON.stringify({ two, total })
	);
}

console.log('\nReview screen: grouping and summary (6)');
const reportCoverage = guardCoverage('shadow', null, null);
{
	const counts = [
		{ path: 'wiki/b.md', kind: 'api-token', count: 1 },
		{ path: 'wiki/a.md', kind: 'date-of-birth', count: 1 },
		{ path: 'wiki/a.md', kind: 'us-ssn', count: 2 },
		{ path: 'wiki/c.md', kind: 'api-token', count: 1 }
	];
	const g = groupDetections(counts);
	check('totals every detection', g.total === 5);
	check(
		'busiest page first, ties by path',
		g.pages.map((p) => p.path).join() === 'wiki/a.md,wiki/b.md,wiki/c.md'
	);
	check(
		"a page's kinds busiest first, with its own total",
		g.pages[0].count === 3 && g.pages[0].kinds.map((k) => k.kind).join() === 'us-ssn,date-of-birth'
	);

	const off = reviewSummary('off', { total: 0, pages: [] }, reportCoverage);
	check('off says so', off.includes('turned off for this brain'));
	check('nothing flagged says so', off.includes('Nothing flagged in the last 30 days.'));
	check(
		'no internal mode names reach people',
		!/shadow/i.test(reviewSummary('shadow', { total: 0, pages: [] }, reportCoverage))
	);
	const on = reviewSummary('shadow', g, reportCoverage);
	check(
		'shadow lists the pages',
		!/shadow/i.test(on) &&
			on.includes('5 detection(s) across 3 page(s)') &&
			on.includes('- wiki/a.md: 2 us-ssn, 1 date-of-birth')
	);
}

done();
