// What the prose in this repo claims about the code, read mechanically: file paths,
// symbol names, tool names and quoted constant values in the docs, plus the `paths:`
// globs of the `.claude/rules/` files. Pure over its inputs, so `pnpm test:docs` can
// pin each extractor, and shared with `scripts/rules-for-change.ts`, which uses the
// glob half to say which rules files a pull request touches.

import { matchesGlob } from 'node:path';

/** Inline code spans outside fenced blocks, with the 1-based line each sits on. */
export function codeSpans(markdown: string): { text: string; line: number }[] {
	const out: { text: string; line: number }[] = [];
	let fenced = false;
	markdown.split('\n').forEach((raw, i) => {
		if (/^\s*(```|~~~)/.test(raw)) {
			fenced = !fenced;
			return;
		}
		if (fenced) return;
		for (const m of raw.matchAll(/`([^`\n]+)`/g)) out.push({ text: m[1], line: i + 1 });
	});
	return out;
}

/** Relative markdown link targets (no scheme, no pure anchor), with their line. */
export function relativeLinks(markdown: string): { target: string; line: number }[] {
	const out: { target: string; line: number }[] = [];
	let fenced = false;
	markdown.split('\n').forEach((raw, i) => {
		if (/^\s*(```|~~~)/.test(raw)) {
			fenced = !fenced;
			return;
		}
		if (fenced) return;
		for (const m of raw.matchAll(/\]\(([^)\s]+)\)/g)) {
			const target = m[1].split('#')[0];
			if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
			out.push({ target, line: i + 1 });
		}
	});
	return out;
}

const REPO_DIRS = [
	'src',
	'app',
	'scripts',
	'dev',
	'docs',
	'tests',
	'migrations',
	'brain-template',
	'.github',
	'.claude'
];

/**
 * A code span that names a file in THIS repository, normalized, or null. Brain paths
 * (`wiki/...`, `tools/...`), globs and placeholders are not claims about the repo.
 * A bare filename counts only for source extensions; a bare `index.md` is a brain page.
 */
export function repoPathIn(span: string): { path: string; bare: boolean } | null {
	const s = span
		.trim()
		.replace(/^\.\//, '')
		.replace(/:\d+(-\d+)?$/, '');
	if (/[*{}<>\s]|\.\.\.|…/.test(s)) return null;
	const first = s.split('/')[0];
	if (s.includes('/') && REPO_DIRS.includes(first) && /^[\w./@-]+$/.test(s)) {
		return { path: s, bare: false };
	}
	if (!s.includes('/') && /^[\w.-]+\.(ts|tsx|sql|jsonc|yml)$/.test(s)) {
		return { path: s, bare: true };
	}
	return null;
}

/**
 * A code span that names a code symbol, or null: `camelCase` with a hump,
 * `PascalCase` with two, or `SCREAMING_SNAKE`, optionally called `()`.
 */
export function symbolIn(span: string): string | null {
	const m = /^([A-Za-z_$][\w$]*)(\(\))?$/.exec(span.trim());
	if (!m) return null;
	const name = m[1];
	if (/^[a-z][a-z0-9]*[A-Z]/.test(name)) return name;
	if (/^[A-Z][a-z0-9]+[A-Z]/.test(name)) return name;
	if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name)) return name;
	return null;
}

// Verbs every tool name in this server starts with. A snake_case word led by one of
// them reads as a tool to a model and to a person, so it must be one.
const TOOL_VERBS = [
	'analytics',
	'attach',
	'browse',
	'configure',
	'connect',
	'create',
	'delete',
	'disconnect',
	'edit',
	'find',
	'ingest',
	'invite',
	'link',
	'list',
	'manage',
	'move',
	'publish',
	'read',
	'remove',
	'resolve',
	'save',
	'search',
	'set',
	'share',
	'submit',
	'switch',
	'sync',
	'synthesize',
	'unlink',
	'update',
	'view',
	'write'
];

// Tool-shaped words that are not tools: a column, a notification, a table.
export const NOT_TOOLS = new Set(['read_only', 'invite_id', 'write_attempts', 'list_changed']);

// A name that is no longer a tool may still be named on a line that says so, which is
// how a rule like "don't re-add update_brain" stays writable. Anywhere else it is a
// stale reference.
export const RETIREMENT_WORDS =
	/\b(re-add|retired|removed|replaced|renamed|merged|formerly|was once|became|old|cut|folded|generali[sz]ed|dropped|now `)/i;

/** Every tool-shaped word in a text, with its line. */
export function toolShapedWords(text: string): { name: string; line: number; text: string }[] {
	const re = new RegExp(`\\b((?:${TOOL_VERBS.join('|')})_[a-z]+(?:_[a-z]+)*)\\b`, 'g');
	const out: { name: string; line: number; text: string }[] = [];
	text.split('\n').forEach((raw, i) => {
		for (const m of raw.matchAll(re)) out.push({ name: m[1], line: i + 1, text: raw });
	});
	return out;
}

/** Tool names registered in a source file, in both registration shapes. */
export function registeredToolNames(source: string): string[] {
	return [
		...Array.from(source.matchAll(/registerAppTool\(\s*server,\s*'([a-z_]+)'/g), (m) => m[1]),
		...Array.from(source.matchAll(/server\.registerTool\(\s*'([a-z_]+)'/g), (m) => m[1])
	];
}

/**
 * `` `NAME` (1500) `` and `` `NAME` = 1500 `` claims in prose. A number followed by a
 * unit (`(5 MB)`, `(2 min)`) is a conversion, not the literal, and is not a claim.
 */
export function constantClaims(markdown: string): { name: string; value: number; line: number }[] {
	const out: { name: string; value: number; line: number }[] = [];
	markdown.split('\n').forEach((raw, i) => {
		const re = /`([A-Z][A-Z0-9_]{2,})`\s*(?:\((\d[\d,_]*)\)|(?:=|\bis)\s*(\d[\d,_]*)(?![\d_]))/g;
		for (const m of raw.matchAll(re)) {
			const value = (m[2] ?? m[3]).replace(/[,_]/g, '').replace(/,$/, '');
			out.push({ name: m[1], value: Number(value), line: i + 1 });
		}
	});
	return out;
}

/** The literal numeric value a source text assigns to NAME, or undefined. */
export function constantValue(source: string, name: string): number | undefined {
	const m = new RegExp(
		`\\b${name}\\s*(?::\\s*[\\w<>\\[\\]]+\\s*)?=\\s*(\\d[\\d_]*)\\s*[;,\\n]`
	).exec(source);
	return m ? Number(m[1].replace(/_/g, '')) : undefined;
}

/** The `paths:` globs of a rules file's YAML frontmatter; [] when it has none. */
export function rulesPaths(markdown: string): string[] {
	const fm = /^---\n([\s\S]*?)\n---/.exec(markdown);
	if (!fm) return [];
	const block = /^paths:\s*\n((?:\s+-\s+.*\n?)+)/m.exec(fm[1] + '\n');
	if (!block) return [];
	return Array.from(block[1].matchAll(/-\s+["']?([^"'\n]+?)["']?\s*$/gm), (m) => m[1]);
}

/**
 * A glob's brace alternatives, each as its own glob, so a check can tell that ONE
 * alternative went dead: `src/lib/{search,gone}.ts` still matches `search.ts`.
 */
export function expandBraces(glob: string): string[] {
	const m = /\{([^{}]*)\}/.exec(glob);
	if (!m) return [glob];
	return m[1]
		.split(',')
		.flatMap((alt) =>
			expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length))
		);
}

/** Does any of these globs match this repo-relative path? */
export function globsMatch(globs: string[], path: string): boolean {
	return globs.some((g) => matchesGlob(path, g));
}

/** Which rules files cover a set of changed paths, in the order given. */
export function rulesFor(
	rules: { file: string; globs: string[] }[],
	changed: string[]
): { file: string; matched: string[] }[] {
	return rules
		.map((r) => ({ file: r.file, matched: changed.filter((p) => globsMatch(r.globs, p)) }))
		.filter((r) => r.matched.length > 0);
}

// The fixed set a design doc's status line must use, so "is this built?" has an
// answer at the top of every design doc rather than somewhere in its body.
export const DESIGN_STATUSES = [
	'built',
	'partly built',
	'in implementation',
	'proposed',
	'draft',
	'decided',
	'superseded',
	'abandoned'
];

/** The status word a design doc declares near its top, or null. */
export function designStatus(markdown: string): string | null {
	const head = markdown.split('\n').slice(0, 25);
	for (const line of head) {
		const m = /^[-*\s]*Status:\s*\**\s*([A-Za-z ]+)/.exec(line);
		if (!m) continue;
		const lead = m[1].trim().toLowerCase();
		return DESIGN_STATUSES.find((s) => lead.startsWith(s)) ?? null;
	}
	return null;
}
