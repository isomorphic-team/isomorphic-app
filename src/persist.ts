// Read/write `.dev.vars` (and `.env`-style files) as a flat key=value store.
//
// Used during bootstrap to persist App credentials returned by GitHub's
// manifest exchange and installation callbacks. Keys we set here are then
// read back from `process.env` on subsequent runs (after `tsx` loads .dev.vars,
// which we do explicitly because we're not using wrangler in the bootstrap).

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEV_VARS_PATH = new URL('../.dev.vars', import.meta.url);

function quote(value: string): string {
	// Quote everything with double quotes, escaping embedded double quotes
	// and newlines. Keeps multi-line values like base64 PEMs safe even though
	// we encode the PEM (so this is mostly defensive).
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function unquote(value: string): string {
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}
	return value;
}

export async function readDevVars(): Promise<Record<string, string>> {
	if (!existsSync(DEV_VARS_PATH)) return {};
	const text = await readFile(DEV_VARS_PATH, 'utf8');
	const out: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		out[trimmed.slice(0, eq)] = unquote(trimmed.slice(eq + 1));
	}
	return out;
}

export async function writeDevVars(updates: Record<string, string>): Promise<void> {
	const current = await readDevVars();
	const merged = { ...current, ...updates };
	const lines = [
		'# Populated by `pnpm bootstrap`. Do not commit this file.',
		'',
		...Object.entries(merged).map(([k, v]) => `${k}=${quote(v)}`)
	];
	await writeFile(DEV_VARS_PATH, lines.join('\n') + '\n', 'utf8');
}

// Loads .dev.vars into process.env so the rest of the app can read it like
// a normal env var.
export async function loadDevVarsIntoEnv(): Promise<void> {
	const vars = await readDevVars();
	for (const [k, v] of Object.entries(vars)) {
		if (process.env[k] === undefined) process.env[k] = v;
	}
}
