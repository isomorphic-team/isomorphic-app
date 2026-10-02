// Golden test for the per-pull-request preview (scripts/preview.ts and
// .github/workflows/preview.yml).
//
//   pnpm test:preview
//
// It exists to catch:
//   1. A preview named or addressed differently from what the workflow assumes: the
//      name, origin and database are derived in one place and pinned here.
//   2. A binding missing from a Preview. A Preview reads only the `previews` block and
//      inherits nothing, so a binding added to wrangler.template.jsonc that the block
//      does not carry deploys a Preview without it, and nothing else would say so.
//   3. A JSONC reader that eats a `//` inside a string (every URL in the config).
//   4. The workflow's security split eroding: secrets reachable from the job that runs
//      pull request code, a pull request checkout under `pull_request_target`, or a
//      production variable or environment used by a preview.

import { readFileSync } from 'node:fs';

import { checker } from './check.ts';
import {
	COMMENT_MARKER,
	databaseIdFrom,
	parseJsonc,
	planPreview,
	previewComment,
	previewConfig,
	previewOriginFrom
} from './preview.ts';

const { check, done } = checker('preview checks');

function throws(run: () => unknown, fragment: string): boolean {
	try {
		run();
		return false;
	} catch (err) {
		return err instanceof Error && err.message.includes(fragment);
	}
}

const BASE = {
	pr: 128,
	workerName: 'example-preview',
	subdomain: 'example',
	databaseBase: 'platform-db-preview'
};

console.log('\nthe plan is derived from the pull request number');
{
	const plan = planPreview(BASE);
	check('name is pr-<number>', plan.name === 'pr-128', plan.name);
	check(
		'origin is <name>-<worker>.<subdomain>.workers.dev',
		plan.origin === 'https://pr-128-example-preview.example.workers.dev',
		plan.origin
	);
	check(
		'database is <base>-pr-<number>',
		plan.databaseName === 'platform-db-preview-pr-128',
		plan.databaseName
	);
	check(
		'a non-number is refused',
		throws(() => planPreview({ ...BASE, pr: NaN }), 'pull request')
	);
	check(
		'zero is refused',
		throws(() => planPreview({ ...BASE, pr: 0 }), 'pull request')
	);
	check(
		'an uppercase worker name is refused',
		throws(() => planPreview({ ...BASE, workerName: 'Example' }), 'PREVIEW_WORKER_NAME')
	);
	check(
		'a full workers.dev hostname as the subdomain is refused',
		throws(
			() => planPreview({ ...BASE, subdomain: 'example.workers.dev' }),
			'PREVIEW_WORKERS_SUBDOMAIN'
		)
	);
	check(
		'a hostname label over 63 characters is refused',
		throws(() => planPreview({ ...BASE, workerName: 'a'.repeat(57) }), '63')
	);
	check(
		'a label of exactly 63 is allowed',
		!throws(() => planPreview({ ...BASE, workerName: 'a'.repeat(56) }), '')
	);
}

console.log('\nJSONC is read without touching strings');
{
	const parsed = parseJsonc(`{
		// a comment
		"url": "https://example.com/path", /* block */
		"s": "a /* not a comment */ b",
		"q": "escaped \\" // still a string",
		"list": [1, 2,],
	}`) as Record<string, unknown>;
	check('a URL survives', parsed.url === 'https://example.com/path', String(parsed.url));
	check('block-comment text inside a string survives', parsed.s === 'a /* not a comment */ b');
	check('an escaped quote does not end the string', parsed.q === 'escaped " // still a string');
	check('trailing commas are dropped', Array.isArray(parsed.list) && parsed.list.length === 2);
}

console.log('\nthe previews block carries every binding the template declares');
{
	const template = parseJsonc(readFileSync('wrangler.template.jsonc', 'utf8')) as Record<
		string,
		unknown
	>;
	const config = previewConfig(template);
	const previews = config.previews as Record<string, unknown>;
	// Every top-level key wrangler treats as a binding or a var. A Preview inherits none of
	// them, so each one the template uses must appear in the block.
	const BINDING_KEYS = [
		'vars',
		'd1_databases',
		'kv_namespaces',
		'r2_buckets',
		'durable_objects',
		'queues',
		'services',
		'analytics_engine_datasets',
		'ai',
		'browser',
		'hyperdrive',
		'vectorize',
		'workflows',
		'send_email',
		'secrets_store_secrets',
		'ratelimits'
	];
	const used = BINDING_KEYS.filter((key) => key in template);
	const missing = used.filter((key) => !(key in previews));
	check('the template parses and declares bindings', used.length > 0, JSON.stringify(used));
	check('every one is carried into previews', missing.length === 0, JSON.stringify(missing));
	check(
		'vars match the top level',
		JSON.stringify(previews.vars) === JSON.stringify(template.vars)
	);
	const d1 = (previews.d1_databases as Record<string, unknown>[])[0];
	check(
		'the D1 binding is the top-level one',
		JSON.stringify(d1) === JSON.stringify((template.d1_databases as unknown[])[0])
	);
	check('the block is a copy, not shared objects', d1 !== (template.d1_databases as unknown[])[0]);
	check(
		'two D1 bindings are refused rather than guessed between',
		throws(
			() =>
				previewConfig({
					d1_databases: [{ binding: 'A' }, { binding: 'B' }]
				}),
			'one D1 binding'
		)
	);
}

console.log('\nwrangler output is read, not assumed');
{
	const list = JSON.stringify([
		{ name: 'platform-db-preview-pr-1', uuid: 'aaaaaaaa-0000-4000-8000-000000000001' },
		{ name: 'platform-db-preview-pr-12', uuid: 'aaaaaaaa-0000-4000-8000-000000000012' }
	]);
	check(
		'the named database is found by exact name',
		databaseIdFrom(list, 'platform-db-preview-pr-1') === 'aaaaaaaa-0000-4000-8000-000000000001'
	);
	check('an absent database is null', databaseIdFrom(list, 'platform-db-preview-pr-2') === null);

	const ndjson = [
		JSON.stringify({ type: 'wrangler-session', version: 1 }),
		JSON.stringify({
			type: 'preview',
			version: 1,
			preview_urls: [
				'https://pr-128.app.example.com',
				'https://pr-128-example-preview.example.workers.dev'
			]
		})
	].join('\n');
	check(
		'the workers.dev URL is preferred over a custom domain',
		previewOriginFrom(ndjson) === 'https://pr-128-example-preview.example.workers.dev'
	);
	check(
		'a Preview with no URL is an error naming preview_urls',
		throws(
			() => previewOriginFrom(JSON.stringify({ type: 'preview', preview_urls: [] })),
			'preview_urls'
		)
	);
	check(
		'no preview entry is an error',
		throws(() => previewOriginFrom(JSON.stringify({ type: 'deploy' })), 'no preview entry')
	);
}

console.log('\nthe comment');
{
	const args = {
		origin: 'https://pr-128-example-preview.example.workers.dev',
		sha: 'a5f9d34702c5f2017b6ca6be98ef608659e1948b',
		runUrl: 'https://github.com/example/repo/actions/runs/1',
		signIn: 'open' as const
	};
	const ok = previewComment({ ...args, smoke: 'success' });
	const email = previewComment({ ...args, smoke: 'success', signIn: 'email' });
	check('open sign-in says no email is sent', ok.includes('no email is sent'));
	check('and names the label that turns email on', ok.includes('`preview-email`'));
	check('email sign-in says a real email is sent', email.includes('real magic-link email'));
	const bad = previewComment({ ...args, smoke: 'failure' });
	check('starts with the marker the workflow searches for', ok.startsWith(COMMENT_MARKER));
	check('links the web app first', ok.indexOf('/b') < ok.indexOf('/mcp'));
	check('names the commit', ok.includes('a5f9d34'));
	check('a failed smoke check says so', bad.includes('Smoke check failed'));
}

console.log('\nthe workflow keeps secrets away from pull request code');
{
	const raw = readFileSync('.github/workflows/preview.yml', 'utf8');
	// Comments explain the rules and so name the things the rules forbid.
	const yaml = raw.replace(/^\s*#.*\n/gm, '');
	// Jobs are the two-space-indented keys under `jobs:`; each runs to the next one.
	const jobsAt = yaml.indexOf('\njobs:\n');
	const jobText = new Map<string, string>();
	const headers = [...yaml.slice(jobsAt).matchAll(/^ {2}([a-z-]+):\s*$/gm)];
	headers.forEach((m, i) => {
		const start = jobsAt + m.index;
		const end = i + 1 < headers.length ? jobsAt + headers[i + 1]!.index : yaml.length;
		jobText.set(m[1]!, yaml.slice(start, end));
	});
	const job = (name: string) => jobText.get(name) ?? '';

	check(
		'jobs resolve, build, deploy and cleanup exist',
		['resolve', 'build', 'deploy', 'cleanup'].every((j) => jobText.has(j))
	);
	check('build references no secret', !/secrets\./.test(job('build')));
	check('build has no environment', !/environment:/.test(job('build')));
	check(
		'build does not leave a git credential in the checkout',
		/persist-credentials: false/.test(job('build'))
	);
	check('build cannot write', /permissions:\n\s+contents: read\n\s+steps:/.test(job('build')));
	check('deploy checks out the default ref', !/^\s+ref:/m.test(job('deploy')));
	const artifactUses = [...job('deploy').matchAll(/artifact\/(\S+?)["\s]/g)].map((m) => m[1]!);
	check(
		'deploy reads only the bundle and the SQL from the artifact',
		artifactUses.length > 0 &&
			artifactUses.every((u) => u === 'bundle/worker.js' || u === 'migrations/*.sql'),
		JSON.stringify(artifactUses)
	);
	check('cleanup checks out the default ref', !/^\s+ref:/m.test(job('cleanup')));
	check(
		'pull_request_target fires only on close',
		/pull_request_target:\n\s+types: \[closed\]/.test(yaml)
	);
	check(
		'only cleanup runs under pull_request_target',
		/if: github\.event_name != 'pull_request_target'/.test(job('resolve')) &&
			/if: github\.event_name == 'pull_request_target'/.test(job('cleanup'))
	);
	check(
		'forks are not previewed from a pull_request event',
		/HEAD_REPO" != "\$THIS_REPO/.test(job('resolve'))
	);
	check('the production environment is never used', !/production/.test(yaml));
	const vars = [...yaml.matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]!);
	check(
		'every repository variable read is a PREVIEW_ one',
		vars.length > 0 && vars.every((v) => v.startsWith('PREVIEW_')),
		JSON.stringify(vars.filter((v) => !v.startsWith('PREVIEW_')))
	);
	check(
		'the comment search uses the same marker',
		yaml.includes(`startswith("${COMMENT_MARKER}")`)
	);
}

console.log('\nopen sign-in is a preview setting and nothing else');
{
	const yaml = readFileSync('.github/workflows/preview.yml', 'utf8').replace(/^\s*#.*\n/gm, '');
	const resolve = yaml.slice(yaml.indexOf('\n  resolve:'), yaml.indexOf('\n  build:'));
	check(
		'previews default to open sign-in',
		/echo "signin=open"/.test(resolve) && /else\n\s+echo "signin=open"/.test(resolve)
	);
	check(
		'the preview-email label switches to email',
		/contains\(github\.event\.pull_request\.labels\.\*\.name, 'preview-email'\)/.test(resolve)
	);
	check(
		'the config step takes the decided mode',
		/AUTH_SIGN_IN: \$\{\{ needs\.resolve\.outputs\.signin \}\}/.test(yaml)
	);
	check(
		'deploy.yml never sets AUTH_SIGN_IN',
		!readFileSync('.github/workflows/deploy.yml', 'utf8').includes('AUTH_SIGN_IN')
	);
	check(
		'setup-config defaults it to email',
		/key: 'AUTH_SIGN_IN',[\s\S]*?default: 'email'/.test(
			readFileSync('scripts/setup-config.ts', 'utf8')
		)
	);
	check(
		'the template fills it from setup-config',
		readFileSync('wrangler.template.jsonc', 'utf8').includes('"AUTH_SIGN_IN": "__AUTH_SIGN_IN__"')
	);
}

done();
