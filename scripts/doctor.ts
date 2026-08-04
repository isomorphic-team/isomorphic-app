// `pnpm doctor` — tell someone what state their checkout is in and what to run next.
//
// Every setup question a new contributor or self-hoster asks is a diagnostic this
// repo could have printed itself: which Node, did setup:config run, which auth mode
// is .dev.vars actually configured for, what is that mode missing. The answers are
// all local, so asking a human is pure latency.
//
// Exit code is 1 only for a HARD blocker (wrong Node, no dependencies). "You have
// not configured a brain yet" is a normal state for someone who just cloned, and a
// doctor that exits non-zero on it teaches people to ignore the exit code.
//
//   pnpm doctor

import { existsSync, readFileSync } from 'node:fs';
import { readDevVars } from '../src/persist.ts';

const root = new URL('../', import.meta.url);
const has = (rel: string) => existsSync(new URL(rel, root));

const OK = '✓';
const WARN = '!';
const BAD = '✗';

let blockers = 0;
const next: string[] = [];

function line(mark: string, text: string, hint?: string) {
	console.log(`  ${mark} ${text}${hint ? `\n      ${hint}` : ''}`);
}

console.log('\nIsomorphic doctor\n');

// ---------- environment ----------
console.log('Environment');

const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
	engines?: { node?: string };
};
const required = Number((pkg.engines?.node ?? '>=24').replace(/[^\d]/g, '')) || 24;
const major = Number(process.versions.node.split('.')[0]);
if (major >= required) {
	line(OK, `Node v${process.versions.node}`);
} else {
	blockers++;
	line(BAD, `Node v${process.versions.node}, but this repo needs >=${required}`, 'nvm use');
}

if (has('node_modules')) {
	line(OK, 'Dependencies installed');
} else {
	blockers++;
	line(BAD, 'No node_modules', 'pnpm install');
	next.push('pnpm install');
}

if (has('wrangler.jsonc')) {
	line(OK, 'wrangler.jsonc generated');
} else {
	line(WARN, 'wrangler.jsonc missing (it is generated and gitignored)', 'pnpm setup:config');
	next.push('pnpm setup:config');
}

// The local D1 lives under .wrangler/state. Its absence just means migrations have
// not been applied locally yet, which every read path needs (the content index).
if (has('.wrangler/state')) {
	line(OK, 'Local D1 state exists');
} else {
	line(WARN, 'No local D1 yet', 'pnpm db:migrate');
	next.push('pnpm db:migrate');
}

// ---------- configuration ----------
console.log('\nConfiguration (.dev.vars)');

const vars = await readDevVars();
const set = (k: string) => Boolean(vars[k]?.trim());

// AUTH_MODE is a generated-config value, not a secret, so it lives in wrangler.jsonc
// unless .dev.vars overrides it. Read both, preferring the override.
let authMode: string | undefined = vars.AUTH_MODE;
if (!authMode && has('wrangler.jsonc')) {
	const raw = readFileSync(new URL('wrangler.jsonc', root), 'utf8');
	authMode = /"AUTH_MODE"\s*:\s*"([^"]*)"/.exec(raw)?.[1];
}

if (!has('.dev.vars')) {
	line(WARN, 'No .dev.vars', 'cp .dev.vars.example .dev.vars');
}

// Which way is this checkout set up to reach a brain? Listed cheapest first, which
// is also the order docs/self-hosting.md presents them.
if (set('GITHUB_TOKEN')) {
	line(OK, 'Token mode: GITHUB_TOKEN is set');
	const missing = ['BRAIN_REPO_OWNER', 'BRAIN_REPO_NAME'].filter((k) => !set(k));
	if (missing.length) {
		line(BAD, `Token mode needs ${missing.join(' and ')}`, 'add them to .dev.vars');
	} else {
		line(OK, `Brain: ${vars.BRAIN_REPO_OWNER}/${vars.BRAIN_REPO_NAME}`);
		next.push('pnpm worker:dev');
	}
} else if (set('GITHUB_APP_ID')) {
	line(OK, 'GitHub App credentials present');
	if (authMode === 'oauth') {
		const missing = ['PLATFORM_ORG', 'PLATFORM_INSTALLATION_ID'].filter((k) => !set(k));
		if (missing.length) line(BAD, `oauth mode needs ${missing.join(' and ')}`, 'pnpm bootstrap');
		else {
			line(OK, `oauth mode, platform org ${vars.PLATFORM_ORG}`);
			next.push('pnpm worker:dev');
		}
		if (!set('AUTH_SECRET')) {
			line(WARN, 'AUTH_SECRET unset (sign-in will not work)', 'openssl rand -hex 32');
		}
	} else {
		const missing = ['GITHUB_APP_INSTALLATION_ID', 'BRAIN_REPO_OWNER', 'BRAIN_REPO_NAME'].filter(
			(k) => !set(k)
		);
		if (missing.length) line(BAD, `static mode needs ${missing.join(', ')}`, 'pnpm bootstrap');
		else if (!set('MCP_BEARER_TOKEN')) {
			line(BAD, 'static mode needs MCP_BEARER_TOKEN', 'openssl rand -hex 32');
		} else {
			line(OK, `static mode, brain ${vars.BRAIN_REPO_OWNER}/${vars.BRAIN_REPO_NAME}`);
			next.push('pnpm worker:dev');
		}
	}
} else {
	line(WARN, 'No brain configured yet');
	console.log(
		'\n      The app UI needs none of this. To work on the viewer, editor, tree, or\n' +
			'      graph, run `pnpm app:dev` and stop reading here.\n\n' +
			'      To serve real MCP against a real repository, the cheapest path is a\n' +
			'      GitHub token: set GITHUB_TOKEN, BRAIN_REPO_OWNER, and BRAIN_REPO_NAME in\n' +
			'      .dev.vars. See docs/self-hosting.md.'
	);
	next.push('pnpm app:dev');
}

// ---------- verdict ----------
console.log('');
if (blockers) {
	console.log(`${blockers} thing(s) need fixing before anything will run.\n`);
} else {
	console.log(`Next: ${next[0] ?? 'pnpm test'}\n`);
}
process.exit(blockers === 0 ? 0 : 1);
