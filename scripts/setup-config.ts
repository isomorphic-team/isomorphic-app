// Generate `wrangler.jsonc` from `wrangler.template.jsonc`.
//
//   pnpm setup:config                 # local development (no Cloudflare account needed)
//   pnpm setup:config --provision     # create the KV namespace + D1 database, fill in real ids
//   pnpm setup:config --help
//
// WHY THIS EXISTS
// ---------------
// A Wrangler config has to carry literal Cloudflare resource ids (KV namespace id,
// D1 database id) — Wrangler does not interpolate environment variables into
// bindings. Committing those ids means committing one specific deployment's
// identity into a repository that many people deploy, which is both a
// sanitization problem for us and a confusing first run for everybody else: a
// fresh clone would `wrangler deploy` straight into "namespace not found".
//
// So `wrangler.jsonc` is GENERATED and gitignored, `wrangler.template.jsonc` is
// committed, and every deployment-specific value comes from an environment
// variable (or `.dev.vars`) with a local-development default. Our hosted
// deployment is then just another set of values, not a different file — see
// docs/design/open-source-boundary.md.
//
// LOCAL IDS ARE FAKE ON PURPOSE
// -----------------------------
// `wrangler dev` and `wrangler d1 migrations apply --local` run against Miniflare,
// which simulates KV and D1 on disk and never resolves the ids against
// Cloudflare's API. So the default profile writes obviously-fake ids and
// everything local works with no Cloudflare account at all. The ids only have to
// be real when you deploy.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readDevVars } from '../src/persist.ts';

const exec = promisify(execFile);

const TEMPLATE_PATH = new URL('../wrangler.template.jsonc', import.meta.url);
const OUTPUT_PATH = new URL('../wrangler.jsonc', import.meta.url);

// Every placeholder in the template, the env var that fills it, and the default
// used when that env var is unset. Order is the order `--help` prints.
const SETTINGS = [
	{
		key: 'WORKER_NAME',
		placeholder: '__WORKER_NAME__',
		default: 'isomorphic-mcp',
		help: 'Cloudflare Worker name. Must be unique within your account.'
	},
	{
		key: 'AUTH_MODE',
		placeholder: '__AUTH_MODE__',
		default: 'static',
		help: '"static" (one shared bearer token, no roles) or "oauth" (multi-tenant orgs + roles).',
		oneOf: ['static', 'oauth']
	},
	{
		key: 'IDENTITY_MODE',
		placeholder: '__IDENTITY_MODE__',
		default: 'github',
		help: 'Upstream identity for oauth mode: "github" (users need GitHub) or "authjs" (email magic link / SSO).',
		oneOf: ['github', 'authjs']
	},
	{
		key: 'PUBLIC_BASE_URL',
		placeholder: '__PUBLIC_BASE_URL__',
		default: 'http://localhost:8787',
		help: 'Public origin of the deployed Worker. Set this to your real URL before deploying.'
	},
	{
		key: 'AUTH_EMAIL_FROM',
		placeholder: '__AUTH_EMAIL_FROM__',
		default: 'Isomorphic <no-reply@example.com>',
		help: 'Magic-link From address (authjs mode). The domain must be verified with your email provider.'
	},
	{
		key: 'AUTO_PROVISION',
		placeholder: '__AUTO_PROVISION__',
		default: 'false',
		help: '"true" creates a brain on a user\'s first request. "false" makes the instance invite-only.',
		oneOf: ['true', 'false']
	},
	{
		// NOT named GITHUB_APP_SLUG. GitHub Actions refuses to create any repository
		// variable whose name starts with `GITHUB_` ("Variable names must not start
		// with GITHUB_", HTTP 422), so a variable by that name can never exist and
		// `vars.GITHUB_APP_SLUG` would silently evaluate to empty forever — taking
		// the self-serve connect_github_org flow down with it, with no error anywhere.
		// The canonical name stays GITHUB_APP_SLUG in `.dev.vars` (that is what
		// `pnpm bootstrap` writes) and in the Worker's own env; only the CI-facing
		// name differs, via fallbackKeys below.
		key: 'APP_SLUG',
		fallbackKeys: ['GITHUB_APP_SLUG'],
		placeholder: '__GITHUB_APP_SLUG__',
		default: '',
		help: 'Your GitHub App slug (github.com/apps/<slug>). Written by `pnpm bootstrap` as GITHUB_APP_SLUG.'
	},
	{
		key: 'USAGE_ANALYTICS',
		placeholder: '__USAGE_ANALYTICS__',
		default: 'true',
		help: '"true" records per-day usage counters and shows the org Analytics tab. Set "false" to disable.',
		oneOf: ['true', 'false']
	},
	{
		key: 'D1_DATABASE_NAME',
		placeholder: '__D1_DATABASE_NAME__',
		default: 'platform-db',
		help: 'D1 database name. Keep the default unless it collides in your account.'
	},
	{
		key: 'CF_D1_DATABASE_ID',
		placeholder: '__D1_DATABASE_ID__',
		default: 'local-dev-d1-database-id',
		help: 'D1 database id. Fake by default; --provision fills in the real one.'
	},
	{
		key: 'CF_OAUTH_KV_ID',
		placeholder: '__OAUTH_KV_ID__',
		default: 'local0dev0oauth0kv0namespace0id0',
		help: 'OAUTH_KV namespace id. Fake by default; --provision fills in the real one.'
	},
	{
		key: 'CF_OAUTH_KV_PREVIEW_ID',
		placeholder: '__OAUTH_KV_PREVIEW_ID__',
		default: 'local0dev0oauth0kv0preview0id00',
		help: 'OAUTH_KV preview namespace id, used by `wrangler dev --remote`.'
	}
] as const;

type Resolved = { value: string; source: 'env' | '.dev.vars' | 'provisioned' | 'default' };

function usage(): void {
	console.log(`
Generate wrangler.jsonc from wrangler.template.jsonc.

Usage
  pnpm setup:config [--provision] [--force] [--print]

Options
  --provision   Create the Cloudflare KV namespace and D1 database if they do not
                exist, and use their real ids. Requires a Cloudflare account and
                \`wrangler login\` (or CLOUDFLARE_API_TOKEN). Without this flag the
                generated config uses fake ids that work for all local development.
  --force       Overwrite an existing wrangler.jsonc without asking.
  --print       Print the resolved settings and exit without writing anything.
  --print-ci    Print the \`gh variable set\` commands that give a GitHub Actions
                deploy the same settings this machine resolves. Writes nothing.
  --help        This text.

Settings are read from the environment first, then from .dev.vars, then fall back
to the local-development default. Each one:
`);
	const width = Math.max(...SETTINGS.map((s) => s.key.length));
	for (const s of SETTINGS) {
		const def = s.default === '' ? '(empty)' : s.default;
		console.log(`  ${s.key.padEnd(width)}  ${s.help}`);
		console.log(`  ${' '.repeat(width)}  default: ${def}`);
	}
	console.log(`
Examples
  pnpm setup:config
      Local development. No Cloudflare account needed. Single bearer token auth.

  PUBLIC_BASE_URL=https://brain.example.com WORKER_NAME=example-brain \\
    pnpm setup:config --provision
      A real single-tenant deployment on your own Cloudflare account.

  AUTH_MODE=oauth IDENTITY_MODE=authjs AUTO_PROVISION=true \\
    PUBLIC_BASE_URL=https://brain.example.com pnpm setup:config --provision
      A multi-tenant deployment with orgs, roles, and email sign-in.

See docs/self-hosting.md for the surrounding steps (GitHub App, secrets, migrations).
`);
}

// `wrangler kv namespace create` / `d1 create` print the id in a block of prose.
// Pull the first id-shaped token out rather than trying to parse their output
// format, which has changed across wrangler majors.
function extractKvId(output: string): string | null {
	return output.match(/\b[0-9a-f]{32}\b/)?.[0] ?? null;
}

function extractD1Id(output: string): string | null {
	return (
		output.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/)?.[0] ?? null
	);
}

async function wrangler(args: string[]): Promise<string> {
	// Wrangler needs a config file for most commands. Resource creation does not,
	// and passing --config would be circular here (we are generating it), so these
	// calls run config-free.
	const { stdout, stderr } = await exec('pnpm', ['exec', 'wrangler', ...args], {
		maxBuffer: 10 * 1024 * 1024
	});
	return stdout + stderr;
}

async function provisionKv(): Promise<{ id: string; previewId: string } | null> {
	console.log('  Creating KV namespace OAUTH_KV …');
	let id: string | null = null;
	let previewId: string | null = null;
	try {
		id = extractKvId(await wrangler(['kv', 'namespace', 'create', 'OAUTH_KV']));
		previewId = extractKvId(await wrangler(['kv', 'namespace', 'create', 'OAUTH_KV', '--preview']));
	} catch (err) {
		// Most likely: the namespace already exists, or wrangler is not logged in.
		// Fall back to listing, which covers the "already exists" case.
		console.log(`  Create failed (${(err as Error).message.split('\n')[0]}), trying list …`);
	}
	if (!id || !previewId) {
		try {
			const listed = JSON.parse(await wrangler(['kv', 'namespace', 'list'])) as Array<{
				id: string;
				title: string;
			}>;
			// Wrangler titles namespaces "<worker-name>-<binding>" and appends
			// "_preview" for the preview namespace.
			id ??= listed.find((n) => /OAUTH_KV$/.test(n.title))?.id ?? null;
			previewId ??= listed.find((n) => /OAUTH_KV_preview$/.test(n.title))?.id ?? null;
		} catch {
			/* fall through to the null return below */
		}
	}
	if (!id) return null;
	return { id, previewId: previewId ?? id };
}

async function provisionD1(name: string): Promise<string | null> {
	console.log(`  Creating D1 database ${name} …`);
	try {
		const id = extractD1Id(await wrangler(['d1', 'create', name]));
		if (id) return id;
	} catch {
		/* probably already exists — fall through to info */
	}
	try {
		return extractD1Id(await wrangler(['d1', 'info', name]));
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) return usage();

	const provision = args.includes('--provision');
	const force = args.includes('--force');
	const printOnly = args.includes('--print');
	const printCi = args.includes('--print-ci');

	const devVars = await readDevVars();
	const resolved = new Map<string, Resolved>();

	for (const s of SETTINGS) {
		// Primary key first, then any legacy/alternate spellings. `fallbackKeys` exists
		// because a setting's canonical name elsewhere (in `.dev.vars`, or in the
		// Worker's env) is sometimes a name GitHub Actions will not accept as a
		// repository variable. See APP_SLUG above.
		const names = [s.key, ...(('fallbackKeys' in s && s.fallbackKeys) || [])];
		let hit: Resolved | undefined;
		for (const n of names) {
			const fromEnv = process.env[n];
			if (fromEnv !== undefined && fromEnv !== '') {
				hit = { value: fromEnv, source: 'env' };
				break;
			}
			const fromFile = devVars[n];
			if (fromFile !== undefined && fromFile !== '') {
				hit = { value: fromFile, source: '.dev.vars' };
				break;
			}
		}
		resolved.set(s.key, hit ?? { value: s.default, source: 'default' });
	}

	// Reject a typo in a constrained setting before it becomes a confusing runtime
	// failure inside the Worker.
	for (const s of SETTINGS) {
		if (!('oneOf' in s) || !s.oneOf) continue;
		const got = resolved.get(s.key)!.value;
		if (!s.oneOf.includes(got as never)) {
			console.error(`\n${s.key}="${got}" is not valid. Expected one of: ${s.oneOf.join(', ')}\n`);
			process.exit(1);
		}
	}

	if (provision) {
		console.log('\nProvisioning Cloudflare resources …');
		const kv = await provisionKv();
		if (kv) {
			resolved.set('CF_OAUTH_KV_ID', { value: kv.id, source: 'provisioned' });
			resolved.set('CF_OAUTH_KV_PREVIEW_ID', { value: kv.previewId, source: 'provisioned' });
		} else {
			console.error(
				'\nCould not create or find the OAUTH_KV namespace.\n' +
					'Run `pnpm exec wrangler login` (or set CLOUDFLARE_API_TOKEN) and try again,\n' +
					'or create it by hand and pass CF_OAUTH_KV_ID / CF_OAUTH_KV_PREVIEW_ID.\n'
			);
			process.exit(1);
		}
		const dbName = resolved.get('D1_DATABASE_NAME')!.value;
		const d1 = await provisionD1(dbName);
		if (d1) {
			resolved.set('CF_D1_DATABASE_ID', { value: d1, source: 'provisioned' });
		} else {
			console.error(
				`\nCould not create or find the D1 database "${dbName}".\n` +
					'Create it by hand and pass CF_D1_DATABASE_ID.\n'
			);
			process.exit(1);
		}
	}

	if (printCi) {
		// None of these are secrets, so they go in as repository VARIABLES: a
		// misconfigured deploy stays diagnosable from the Actions UI, where a secret
		// would show as three asterisks. The Cloudflare API token is the only secret,
		// and it is not ours to print.
		console.log(
			'\n# Give a GitHub Actions deploy the settings this machine resolved.\n' +
				'# Run from the repository, with the right `gh` account active.\n'
		);
		for (const s of SETTINGS) {
			const value = resolved.get(s.key)!.value;
			if (value === '') continue;
			console.log(`gh variable set ${s.key} --body ${JSON.stringify(value)}`);
		}
		console.log(
			'\n# The one actual secret, if it is not already set:\n' +
				'# gh secret set CLOUDFLARE_API_TOKEN\n'
		);
		return;
	}

	// Report what we resolved, so a wrong value is visible now rather than at deploy.
	const width = Math.max(...SETTINGS.map((s) => s.key.length));
	console.log('\nResolved settings:');
	for (const s of SETTINGS) {
		const { value, source } = resolved.get(s.key)!;
		const shown = value === '' ? '(empty)' : value;
		console.log(`  ${s.key.padEnd(width)}  ${shown}   [${source}]`);
	}

	const usingFakeIds =
		resolved.get('CF_OAUTH_KV_ID')!.source === 'default' ||
		resolved.get('CF_D1_DATABASE_ID')!.source === 'default';

	if (printOnly) return;

	if (existsSync(OUTPUT_PATH) && !force) {
		const existing = await readFile(OUTPUT_PATH, 'utf8');
		if (!existing.includes('GENERATED FILE')) {
			console.error(
				'\nwrangler.jsonc exists and was not generated by this script.\n' +
					'It may be a hand-maintained config from before wrangler.jsonc became generated.\n' +
					'Back it up, copy any values you need into .dev.vars, then re-run with --force.\n'
			);
			process.exit(1);
		}
	}

	let out = await readFile(TEMPLATE_PATH, 'utf8');
	for (const s of SETTINGS) {
		const value = resolved.get(s.key)!.value;
		// Plain split/join rather than String.replace: a `$` in a resolved value
		// would otherwise be interpreted as a replacement pattern. This exact class
		// of bug once silently corrupted the generated app bundle (see
		// docs/references.md), so the codebase avoids pattern-replace in codegen.
		out = out.split(s.placeholder).join(value);
	}

	const remaining = out.match(/__[A-Z0-9_]+__/g);
	if (remaining) {
		console.error(
			`\nTemplate has placeholders this script does not know how to fill: ${[
				...new Set(remaining)
			].join(', ')}\n` + 'Add them to SETTINGS in scripts/setup-config.ts.\n'
		);
		process.exit(1);
	}

	const header = [
		'// GENERATED FILE — do not edit.',
		'//',
		'// Generated by `pnpm setup:config` from wrangler.template.jsonc.',
		"// This file is gitignored: it holds one deployment's identity (Worker name,",
		'// public URL, Cloudflare resource ids), which is per-deployment rather than',
		'// per-repository. Edit wrangler.template.jsonc to change what everybody gets,',
		'// or your .dev.vars / CI secrets to change only this deployment.',
		'//',
		'// Regenerate: pnpm setup:config --force',
		''
	].join('\n');

	await writeFile(OUTPUT_PATH, header + out, 'utf8');
	console.log('\nWrote wrangler.jsonc');

	if (usingFakeIds) {
		console.log(
			'\nUsing placeholder Cloudflare resource ids. That is correct for local\n' +
				'development (`pnpm worker:dev`, `pnpm db:migrate`), which runs against\n' +
				'Miniflare and never contacts Cloudflare. Before deploying, run\n' +
				'`pnpm setup:config --provision --force`.'
		);
	}
	console.log('\nNext: pnpm db:migrate    then    pnpm worker:dev\n');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
