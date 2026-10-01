// Planning for the per-pull-request Worker Preview (.github/workflows/preview.yml).
//
// Every value a preview is identified by (its name, its origin, its database) is derived
// here from the pull request number and the preview profile's variables, so the workflow
// computes each one in exactly one place and `pnpm test:preview` can pin them.
//
//   tsx scripts/preview.ts plan                       # GITHUB_OUTPUT lines
//   tsx scripts/preview.ts config <in.jsonc> <out.json>
//   tsx scripts/preview.ts database-id <name>  < `wrangler d1 list --json`
//   tsx scripts/preview.ts preview-url         < wrangler's ndjson output
//   tsx scripts/preview.ts comment                    # the pull request comment body
//
// Inputs come from the environment: PR_NUMBER, PREVIEW_WORKER_NAME,
// PREVIEW_WORKERS_SUBDOMAIN, PREVIEW_D1_DATABASE_NAME, and for `comment` also
// PREVIEW_ORIGIN, PREVIEW_SHA, PREVIEW_SMOKE (success | failure), PREVIEW_RUN_URL.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** DNS caps a hostname label at 63 characters; `<preview>-<worker>` is one label. */
export const MAX_LABEL_LENGTH = 63;

/** Identifies the comment the workflow edits in place instead of appending one per push. */
export const COMMENT_MARKER = '<!-- isomorphic-preview -->';

export type PreviewInputs = {
	pr: number;
	workerName: string;
	subdomain: string;
	databaseBase: string;
};

export type PreviewPlan = {
	name: string;
	origin: string;
	databaseName: string;
};

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function planPreview(inputs: PreviewInputs): PreviewPlan {
	const { pr, workerName, subdomain, databaseBase } = inputs;
	if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error(`Not a pull request number: ${pr}`);
	if (!LABEL.test(workerName))
		throw new Error(
			`PREVIEW_WORKER_NAME must be lowercase letters, digits and dashes: ${workerName}`
		);
	if (!LABEL.test(subdomain))
		throw new Error(
			`PREVIEW_WORKERS_SUBDOMAIN is the account's workers.dev subdomain alone, e.g. "example" for example.workers.dev: ${subdomain}`
		);
	if (!/^[A-Za-z0-9_-]+$/.test(databaseBase))
		throw new Error(`PREVIEW_D1_DATABASE_NAME must be a plain D1 name: ${databaseBase}`);
	const name = `pr-${pr}`;
	const label = `${name}-${workerName}`;
	if (label.length > MAX_LABEL_LENGTH)
		throw new Error(
			`"${label}" is ${label.length} characters; a preview hostname label allows ${MAX_LABEL_LENGTH}. Shorten PREVIEW_WORKER_NAME.`
		);
	return {
		name,
		origin: `https://${label}.${subdomain}.workers.dev`,
		databaseName: `${databaseBase}-pr-${pr}`
	};
}

/** Parses JSONC: `//` and `/* *\/` comments and trailing commas, never inside strings. */
export function parseJsonc(text: string): unknown {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

type WranglerConfig = Record<string, unknown> & {
	vars?: Record<string, string>;
	d1_databases?: Record<string, unknown>[];
	kv_namespaces?: Record<string, unknown>[];
};

/**
 * The generated config plus a `previews` block, which `wrangler preview` requires and reads
 * INSTEAD of the top level: a Preview inherits no vars or bindings. The workflow generates
 * the top level from the preview profile, with the pull request's own database, so the
 * block repeats it.
 */
export function previewConfig(config: WranglerConfig): WranglerConfig {
	const databases = config.d1_databases ?? [];
	if (databases.length !== 1)
		throw new Error(`Expected one D1 binding in the generated config, found ${databases.length}`);
	return {
		...config,
		previews: {
			vars: { ...config.vars },
			d1_databases: [{ ...databases[0] }],
			kv_namespaces: (config.kv_namespaces ?? []).map((kv) => ({ ...kv }))
		}
	};
}

/** The id of the named database in `wrangler d1 list --json` output, or null when absent. */
export function databaseIdFrom(listJson: string, name: string): string | null {
	const parsed: unknown = JSON.parse(listJson);
	if (!Array.isArray(parsed)) throw new Error('wrangler d1 list --json did not return an array');
	for (const entry of parsed) {
		if (entry && typeof entry === 'object' && (entry as { name?: unknown }).name === name) {
			const id = (entry as { uuid?: unknown }).uuid;
			if (typeof id !== 'string' || !id) throw new Error(`Database ${name} has no uuid`);
			return id;
		}
	}
	return null;
}

/** The workers.dev origin of the Preview wrangler reported, from its ndjson output file. */
export function previewOriginFrom(ndjson: string): string {
	const entries = ndjson
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((entry) => entry.type === 'preview');
	const entry = entries.at(-1);
	if (!entry) throw new Error('wrangler reported no preview entry');
	const urls = Array.isArray(entry.preview_urls)
		? entry.preview_urls.filter((u): u is string => typeof u === 'string')
		: [];
	const url = urls.find((u) => new URL(u).hostname.endsWith('.workers.dev')) ?? urls[0];
	if (!url)
		throw new Error(
			'The Preview has no URL. The preview Worker needs `preview_urls: true`, applied by one `wrangler deploy`.'
		);
	return new URL(url).origin;
}

export type CommentInputs = {
	origin: string;
	sha: string;
	smoke: 'success' | 'failure';
	runUrl: string;
};

export function previewComment({ origin, sha, smoke, runUrl }: CommentInputs): string {
	const short = sha.slice(0, 7);
	const status =
		smoke === 'success'
			? `Smoke check passed on \`${short}\`.`
			: `**Smoke check failed** on \`${short}\`. The preview is up but not healthy; see [the run](${runUrl}).`;
	return [
		COMMENT_MARKER,
		'### Preview',
		'',
		status,
		'',
		`- Web app: ${origin}/b`,
		`- Connector URL: \`${origin}/mcp\``,
		'',
		'An isolated Worker Preview with its own database and GitHub App, never production. ' +
			'Each push redeploys it; closing the pull request deletes it.',
		'',
		`<sub>[Workflow run](${runUrl})</sub>`
	].join('\n');
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

function inputsFromEnv(): PreviewInputs {
	return {
		pr: Number(required('PR_NUMBER')),
		workerName: required('PREVIEW_WORKER_NAME'),
		subdomain: required('PREVIEW_WORKERS_SUBDOMAIN'),
		databaseBase: required('PREVIEW_D1_DATABASE_NAME')
	};
}

function main(argv: string[]): void {
	const [command, ...args] = argv;
	const stdin = () => readFileSync(0, 'utf8');
	switch (command) {
		case 'plan': {
			const plan = planPreview(inputsFromEnv());
			console.log(`name=${plan.name}\norigin=${plan.origin}\ndatabase=${plan.databaseName}`);
			return;
		}
		case 'config': {
			const [input, output] = args;
			if (!input || !output) throw new Error('usage: preview.ts config <in.jsonc> <out.json>');
			const config = parseJsonc(readFileSync(input, 'utf8')) as WranglerConfig;
			writeFileSync(output, JSON.stringify(previewConfig(config), null, '\t') + '\n');
			return;
		}
		case 'database-id': {
			if (!args[0]) throw new Error('usage: preview.ts database-id <name>');
			console.log(databaseIdFrom(stdin(), args[0]) ?? '');
			return;
		}
		case 'preview-url': {
			console.log(previewOriginFrom(stdin()));
			return;
		}
		case 'comment': {
			console.log(
				previewComment({
					origin: required('PREVIEW_ORIGIN'),
					sha: required('PREVIEW_SHA'),
					smoke: required('PREVIEW_SMOKE') === 'success' ? 'success' : 'failure',
					runUrl: required('PREVIEW_RUN_URL')
				})
			);
			return;
		}
		default:
			throw new Error(`unknown command: ${command ?? '(none)'}`);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
