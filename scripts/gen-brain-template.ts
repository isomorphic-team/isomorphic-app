// Codegen: brain-template/ → src/lib/brain-template.generated.ts
//
// The brain scaffold's file contents live in `brain-template/` as the editable
// source of truth (see CLAUDE.md). The bootstrap server (Node) can read them
// with `node:fs`, but the MCP Worker — which now auto-provisions brains on
// first authenticated use — runs on Cloudflare Workers and has no filesystem.
//
// This script reads the templates at build time and emits a plain TS module of
// string constants that BOTH runtimes import identically. Run it whenever you
// edit anything under `brain-template/`:
//
//   pnpm gen:templates
//
// The generated file is committed so deploys don't depend on running codegen.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = new URL('../brain-template/', import.meta.url);
const OUT_PATH = new URL('../src/lib/brain-template.generated.ts', import.meta.url);

// Maps the on-disk template filename to the exported constant name.
const TEMPLATES: Record<string, string> = {
	'AGENTS.md': 'AGENTS_MD',
	'README.md': 'README_MD',
	'brain-gitignore': 'GITIGNORE',
	'wiki-log.md': 'WIKI_LOG_MD',
	'wiki-open-questions.md': 'WIKI_OPEN_QUESTIONS_MD'
};

// Backtick-safe: escape backslashes, backticks, and `${` so template literals
// can hold the raw file content verbatim.
function toTemplateLiteral(content: string): string {
	const escaped = content.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
	return `\`${escaped}\``;
}

async function main(): Promise<void> {
	const entries: string[] = [];
	for (const [filename, constName] of Object.entries(TEMPLATES)) {
		const content = await readFile(fileURLToPath(new URL(filename, TEMPLATE_DIR)), 'utf8');
		entries.push(`export const ${constName} = ${toTemplateLiteral(content)};`);
	}

	const banner = `// GENERATED FILE — do not edit by hand.
// Source: brain-template/*. Regenerate with \`pnpm gen:templates\`.
// This module is imported by the MCP Worker (no filesystem) and the bootstrap
// server alike, so the brain scaffold stays identical across both runtimes.
`;

	await writeFile(fileURLToPath(OUT_PATH), banner + '\n' + entries.join('\n\n') + '\n', 'utf8');
	console.log(`Wrote ${fileURLToPath(OUT_PATH)} (${Object.keys(TEMPLATES).length} templates).`);
}

await main();
