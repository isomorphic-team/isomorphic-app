// Golden test for the user-defined tools parse layer (src/lib/custom-tools.ts):
// the tools/ discovery predicate, tool_ naming, the ```tool fence grammar
// (input/op/arg/widget/view), zod input building, and {{arg}} interpolation.
// Pure — no D1, no GitHub. Run: pnpm test:tools
import { z } from 'zod';
import {
	isToolPagePath,
	toolNameFor,
	parseToolDef,
	zodShapeFor,
	fill,
	planCustomTools,
	MAX_CUSTOM_TOOLS
} from '../src/lib/custom-tools.ts';

import { checker } from './check.ts';

const { check, done } = checker('tool checks');

// ---------- discovery predicate ----------
check('tool page: wiki/tools/x.md', isToolPagePath('wiki/tools/standup.md'));
check('tool page: top-level tools/x.md', isToolPagePath('tools/x.md'));
check('not a tool: wiki/notes.md', !isToolPagePath('wiki/notes.md'));
check('not a tool: folder note tools/index.md', !isToolPagePath('wiki/tools/index.md'));
check('not a tool: folder note tools/README.md', !isToolPagePath('wiki/tools/README.md'));
check('not a tool: tools.md (segment is filename)', !isToolPagePath('wiki/tools.md'));
check('not a tool: non-md', !isToolPagePath('wiki/tools/x.txt'));

// ---------- naming ----------
check(
	'name: standup-digest → tool_standup_digest',
	toolNameFor('wiki/tools/standup-digest.md') === 'tool_standup_digest'
);
check(
	'name: "Open Customers" → tool_open_customers',
	toolNameFor('tools/Open Customers.md') === 'tool_open_customers'
);
check('name: unusable filename → null', toolNameFor('tools/---.md') === null);

// ---------- prompt tool (no fence) ----------
{
	const md = `---\ntitle: Weekly Digest\ndescription: Draft a weekly digest.\n---\nYou are drafting a weekly digest for {{project}}. Be terse.`;
	const { def, error } = parseToolDef('wiki/tools/digest.md', md);
	check('prompt: parses', !!def, error);
	check('prompt: name', def?.name === 'tool_digest');
	check('prompt: title from frontmatter', def?.displayTitle === 'Weekly Digest');
	check('prompt: description from frontmatter', def?.description === 'Draft a weekly digest.');
	check('prompt: no op/view', !def?.op && def?.view === undefined);
	check(
		'prompt: instructions retain placeholder',
		def?.instructions.includes('{{project}}') === true
	);
	check('prompt: no params', def?.params.length === 0);
}

// ---------- bound-operation tool ----------
{
	const md = [
		'---',
		'description: Standup digest.',
		'---',
		'Summarize the results below by author.',
		'',
		'```tool',
		'input: project (string) project folder, e.g. acme',
		'input: days (number, default=7) look-back window',
		'op: search_pages',
		'arg: prefix = projects/{{project}}/',
		'arg: query = {{project}}',
		'```'
	].join('\n');
	const { def, error } = parseToolDef('wiki/tools/standup.md', md);
	check('op: parses', !!def, error);
	check('op: op name', def?.op === 'search_pages');
	check('op: two params', def?.params.length === 2);
	check('op: project is string', def?.params[0].type === 'string');
	check('op: project description', def?.params[0].description === 'project folder, e.g. acme');
	check('op: days is number', def?.params[1].type === 'number');
	check('op: days default 7', def?.params[1].default === '7');
	check('op: arg templates retained', def?.opArgs.prefix === 'projects/{{project}}/');
	check('op: instructions kept', def?.instructions === 'Summarize the results below by author.');
}

// ---------- view + widget tool ----------
{
	const md = [
		'---',
		'description: Active customers.',
		'---',
		'```tool',
		'input: status (enum: active|churned|prospect, default=active)',
		'widget',
		'view:',
		'kind: pages',
		'under: customers/',
		'filter:',
		'  status: {{status}}',
		'```'
	].join('\n');
	const { def, error } = parseToolDef('wiki/tools/customers.md', md);
	check('view: parses', !!def, error);
	check('view: widget flag', def?.widget === true);
	check('view: enum param', def?.params[0].type === 'enum');
	check(
		'view: enum values',
		JSON.stringify(def?.params[0].enumValues) === JSON.stringify(['active', 'churned', 'prospect'])
	);
	check('view: enum default', def?.params[0].default === 'active');
	check(
		'view: directive captured verbatim (nested indentation preserved)',
		def?.view === 'kind: pages\nunder: customers/\nfilter:\n  status: {{status}}'
	);
	check('view: no op', def?.op === undefined);
}

// ---------- error cases ----------
function errOf(path: string, md: string): string | undefined {
	return parseToolDef(path, md).error;
}
const fence = (lines: string[]) =>
	['---', 'description: x.', '---', '```tool', ...lines, '```'].join('\n');
check('err: unknown op', !!errOf('tools/a.md', fence(['op: delete_everything'])));
check('err: op + view', !!errOf('tools/a.md', fence(['op: search_pages', 'view:', 'kind: pages'])));
check('err: empty tool', !!errOf('tools/a.md', '---\ndescription: x.\n---\n'));
check('err: enum without values', !!errOf('tools/a.md', fence(['input: s (enum:)'])));
check('err: reserved brain input', !!errOf('tools/a.md', fence(['input: brain (string)'])));
check(
	'err: duplicate input',
	!!errOf('tools/a.md', fence(['input: x (string)', 'input: x (number)']))
);
check('err: bad arg (no =)', !!errOf('tools/a.md', fence(['op: search_pages', 'arg: query'])));
check('err: unusable filename', !!errOf('tools/---.md', 'body'));

// ---------- zod input building ----------
{
	const md = [
		'---',
		'description: x.',
		'---',
		'Draft something.',
		'',
		'```tool',
		'input: project (string) folder',
		'input: days (number, default=7)',
		'input: status (enum: a|b, default=a)',
		'```'
	].join('\n');
	const { def, error } = parseToolDef('tools/z.md', md);
	check('zod: fixture parses', !!def, error);
	const shape = zodShapeFor(def!.params);
	const schema = z.object(shape);
	const parsed = schema.parse({ project: 'acme' });
	check('zod: default applied for days', (parsed as { days: number }).days === 7);
	check(
		'zod: number coercion',
		(schema.parse({ project: 'x', days: '3' }) as { days: number }).days === 3
	);
	check('zod: enum default', (parsed as { status: string }).status === 'a');
	check('zod: enum rejects bad value', !schema.safeParse({ project: 'x', status: 'zzz' }).success);
	check('zod: brain arg is optional', schema.safeParse({ project: 'x' }).success);
	check('zod: missing required string fails', !schema.safeParse({}).success);
}

// ---------- interpolation (pure, no code execution) ----------
check('fill: substitutes', fill('a/{{project}}/b', { project: 'acme' }) === 'a/acme/b');
check('fill: unknown → empty', fill('x{{nope}}y', {}) === 'xy');
check('fill: value is data, not code', fill('{{a}}', { a: '{{b}}' }) === '{{b}}');
check('fill: coerces non-strings', fill('n={{n}}', { n: 7 }) === 'n=7');

// ---------- which pages register (planCustomTools) ----------
// The loader registers `defs` and validate reports `errors`, from this ONE function.
// The two used to carry separate copies, and validate's had no cap: a page past it
// never registered and validate said nothing.
{
	const tool = (desc: string) => `---\ndescription: ${desc}\n---\nDo the thing.`;
	const page = (path: string, content: string | null = tool(path)) => ({ path, content });

	const clean = planCustomTools([page('wiki/tools/b.md'), page('wiki/tools/a.md')]);
	check('plan: good pages register', clean.defs.length === 2 && clean.errors.length === 0);
	check('plan: in path order, whatever order they were listed', clean.defs[0].name === 'tool_a');

	const dup = planCustomTools([page('zeta/tools/a.md'), page('alpha/tools/a.md')]);
	check('plan: a duplicate name registers once', dup.defs.length === 1);
	check(
		'plan: the FIRST by path registers, so validate names the loser the loader actually dropped',
		dup.defs[0].sourcePath === 'alpha/tools/a.md' && dup.errors[0]?.sourcePath === 'zeta/tools/a.md'
	);
	check(
		'plan: the duplicate names the page it collides with',
		dup.errors[0]?.error.includes('alpha/tools/a.md') === true
	);

	const broken = planCustomTools([page('wiki/tools/x.md', '```tool\nop: rm_rf\n```')]);
	check(
		'plan: a malformed page is an error, not a tool',
		broken.defs.length === 0 && broken.errors.length === 1
	);
	check(
		'plan: a page gone between listing and fetch is skipped silently',
		planCustomTools([page('wiki/tools/x.md', null)]).errors.length === 0
	);

	const many = Array.from({ length: MAX_CUSTOM_TOOLS + 3 }, (_, i) =>
		page(`wiki/tools/t${String(i).padStart(2, '0')}.md`)
	);
	const capped = planCustomTools(many);
	check('plan: registration stops at the cap', capped.defs.length === MAX_CUSTOM_TOOLS);
	check(
		'plan: every page past the cap is REPORTED, which validate did not do',
		capped.errors.length === 3 &&
			capped.errors.every((e) => e.error.includes(`${MAX_CUSTOM_TOOLS}-tool limit`))
	);
	check(
		'plan: the ones past the cap are the last by path',
		capped.errors[0]?.sourcePath === `wiki/tools/t${MAX_CUSTOM_TOOLS}.md`
	);
	check(
		'plan: a duplicate does not use up a slot under the cap',
		planCustomTools([...many.slice(0, MAX_CUSTOM_TOOLS), page('other/tools/t00.md')]).defs
			.length === MAX_CUSTOM_TOOLS
	);
}

done();
