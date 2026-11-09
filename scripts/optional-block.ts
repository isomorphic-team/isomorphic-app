// Optional blocks in wrangler.template.jsonc, for `pnpm setup:config`.
//
// A block sits between `// <name>:start` and `// <name>:end` comment lines and follows
// the previous array element's `},`. Dropping it removes the block, the comment lines
// directly above it and that comma.

/** The template with the named block kept (markers removed) or dropped. */
export function optionalBlock(template: string, name: string, keep: boolean): string {
	const lines = template.split('\n');
	const start = lines.findIndex((l) => l.trim() === `// ${name}:start`);
	const end = lines.findIndex((l) => l.trim() === `// ${name}:end`);
	if (start < 0 || end < start) throw new Error(`no "${name}" block in the template`);
	if (keep) return lines.filter((_, i) => i !== start && i !== end).join('\n');
	let from = start;
	while (from > 0 && lines[from - 1].trim().startsWith('//')) from--;
	const before = lines.slice(0, from);
	const last = before.length - 1;
	if (!before[last].trimEnd().endsWith(',')) {
		throw new Error(`the "${name}" block must follow an element ending in a comma`);
	}
	before[last] = before[last].replace(/,\s*$/, '');
	return [...before, ...lines.slice(end + 1)].join('\n');
}
