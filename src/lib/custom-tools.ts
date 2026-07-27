// User-defined tools ("brain-tools"). A tool is an ordinary content page that
// lives under a `tools/` folder in the brain. Its behavior is declared in a
// fenced ```tool block (the okf-view precedent — a small line grammar, not YAML,
// so it survives the flat frontmatter parser and ProseMirror round-trips), and
// the surrounding page body is the instruction payload handed to the model.
//
// This module is PURE + Worker-safe (no node:*, no octokit, no D1): it only
// parses a page into a CustomToolDef and builds the zod input shape. Discovery
// (which pages) and execution (running the op/view) live in ../tools/custom.ts,
// which needs the index + GitHub. Keeping the parse layer pure makes it golden-
// testable (pnpm test:tools) exactly like view-directives.ts.
//
// Nothing a brain-tool does escapes the brain: a tool either returns its
// interpolated instructions to the model (a saved "skill"), runs one whitelisted
// READ primitive and appends the result, or renders one okf-view. Arguments are
// interpolated as DATA ({{name}} substitution), never evaluated — there is no
// expression language, so a tool page can't execute arbitrary code.

import { z } from 'zod';
import { parseFrontmatter } from './wiki.ts';
import { FOLDER_NOTE_NAMES } from './view-directives.ts';

// The whitelisted read operations a bound-operation tool may invoke. Deliberately
// read-only for v1: a custom tool can search/read/summarize the brain but never
// mutate it, so authoring a tool can't exceed what the caller could already read.
export const OP_NAMES = ['search_pages', 'read_page', 'find_inbound_links', 'list_pages'] as const;
export type OpName = (typeof OP_NAMES)[number];

export type ParamType = 'string' | 'number' | 'boolean' | 'enum';

export interface ToolParam {
	name: string;
	type: ParamType;
	/** Allowed values when type === 'enum'. */
	enumValues?: string[];
	description?: string;
	/** Raw default token; coerced to the param type at zod-build time. */
	default?: string;
	optional?: boolean;
}

export interface CustomToolDef {
	/** Registered MCP tool name, e.g. `tool_standup_digest`. */
	name: string;
	/** Human title for the tool list (from frontmatter title or the deslugged filename). */
	displayTitle: string;
	description: string;
	/** The source page path, e.g. `wiki/tools/standup-digest.md`. */
	sourcePath: string;
	params: ToolParam[];
	/** Body outside the ```tool fence — the prompt payload (may be empty). */
	instructions: string;
	/** Bound-operation mode: run this whitelisted read primitive. */
	op?: OpName;
	/** Arguments for `op`, values may contain {{param}} placeholders. */
	opArgs: Record<string, string>;
	/** View mode: an okf-view directive template (interpolated, then rendered). */
	view?: string;
	/** Open the result in the in-client viewer widget (view mode; opt-in otherwise). */
	widget: boolean;
}

export interface ToolParseError {
	sourcePath: string;
	error: string;
}

export type ToolParseResult =
	| { def: CustomToolDef; error?: undefined }
	| { def?: undefined; error: string };

// ---------- discovery predicate ----------

// A tool page is any markdown page with a `tools` path segment that isn't a
// folder note (a `tools/index.md` is the folder's own page, not a tool). Used by
// both discovery (which pages to parse) and the librarian's reconnect hint (which
// writes should mention reconnecting).
export function isToolPagePath(path: string): boolean {
	if (!path.endsWith('.md')) return false;
	const segments = path.split('/');
	const base = segments[segments.length - 1];
	if (FOLDER_NOTE_NAMES.includes(base)) return false;
	// A `tools` segment anywhere except the filename itself (so `tools.md` is a
	// normal page, but `tools/x.md` and `wiki/tools/x.md` are tool pages).
	return segments.slice(0, -1).includes('tools');
}

// ---------- naming ----------

// Registered name: `tool_` + the filename slugged to a safe identifier. The
// prefix guarantees no collision with a first-party tool and makes provenance
// obvious in the tool list. Returns null when the filename slugs to nothing.
export function toolNameFor(path: string): string | null {
	const base = path.split('/').pop()!.replace(/\.md$/, '');
	const slug = base
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!slug) return null;
	return `tool_${slug}`;
}

function deslug(path: string): string {
	return path.split('/').pop()!.replace(/\.md$/, '').replace(/[-_]+/g, ' ').trim();
}

// ---------- the ```tool fence grammar ----------
//
//   input: project (string) project folder, e.g. acme
//   input: days (number, default=7) look-back window
//   input: status (enum: active|churned|prospect, default=active)
//   op: search_pages
//   arg: prefix = projects/{{project}}/
//   arg: query = {{project}}
//   widget
//   view:
//   kind: pages
//   under: customers/
//   ...            <- everything after `view:` is the okf-view directive, verbatim
//
// `view:` must be the last directive in the block — its body runs to the fence
// close. `op`/`arg` and `view` are mutually exclusive; the parser rejects both.

const FENCE_RE = /```tool[ \t]*\r?\n([\s\S]*?)\r?\n```/;
const IDENT_RE = /^[a-z][a-z0-9_]*$/i;

interface SpecParse {
	params: ToolParam[];
	op?: OpName;
	opArgs: Record<string, string>;
	view?: string;
	widget: boolean;
	instructions: string;
	error?: string;
}

function parseParamLine(rest: string): ToolParam | string {
	// `<name> (<attrs>) <description>`  — attrs and description optional.
	const m = rest.match(/^([a-z][a-z0-9_]*)\s*(?:\(([^)]*)\))?\s*(.*)$/i);
	if (!m) return `invalid input line: "${rest}"`;
	const [, name, attrs, desc] = m;
	const param: ToolParam = { name, type: 'string' };
	if (attrs) {
		for (const rawTok of attrs.split(',')) {
			const tok = rawTok.trim();
			if (!tok) continue;
			if (tok === 'string' || tok === 'number' || tok === 'boolean') {
				param.type = tok;
			} else if (tok === 'optional') {
				param.optional = true;
			} else if (tok.startsWith('enum:')) {
				param.type = 'enum';
				param.enumValues = tok
					.slice('enum:'.length)
					.split('|')
					.map((s) => s.trim())
					.filter(Boolean);
			} else if (tok.startsWith('default=')) {
				param.default = tok.slice('default='.length).trim();
			} else {
				return `unknown attribute "${tok}" on input "${name}"`;
			}
		}
	}
	if (param.type === 'enum' && (!param.enumValues || param.enumValues.length === 0)) {
		return `enum input "${name}" needs values, e.g. (enum: a|b|c)`;
	}
	if (desc.trim()) param.description = desc.trim();
	return param;
}

function parseSpec(fenceBody: string): SpecParse {
	const out: SpecParse = { params: [], opArgs: {}, widget: false, instructions: '' };
	const lines = fenceBody.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.trim();
		if (line === '') continue;

		if (line === 'widget' || line === 'widget: true') {
			out.widget = true;
			continue;
		}
		const colon = line.indexOf(':');
		const key = colon >= 0 ? line.slice(0, colon).trim() : line;
		const value = colon >= 0 ? line.slice(colon + 1).trim() : '';

		if (key === 'input') {
			const p = parseParamLine(value);
			if (typeof p === 'string') return { ...out, error: p };
			if (out.params.some((x) => x.name === p.name)) {
				return { ...out, error: `duplicate input "${p.name}"` };
			}
			out.params.push(p);
		} else if (key === 'op') {
			if (!OP_NAMES.includes(value as OpName)) {
				return { ...out, error: `unknown op "${value}" (allowed: ${OP_NAMES.join(', ')})` };
			}
			out.op = value as OpName;
		} else if (key === 'arg') {
			const eq = value.indexOf('=');
			if (eq < 0) return { ...out, error: `arg needs "key = value": "${value}"` };
			out.opArgs[value.slice(0, eq).trim()] = value.slice(eq + 1).trim();
		} else if (key === 'view') {
			// The rest of the block is the okf-view directive, verbatim (with the
			// remainder of this line if any). Everything after `view:` belongs to it.
			const tail = value ? [value] : [];
			out.view = [...tail, ...lines.slice(i + 1)].join('\n').trim();
			break;
		} else {
			return { ...out, error: `unknown directive "${key}" in tool block` };
		}
	}
	return out;
}

// ---------- top-level parse ----------

export function parseToolDef(path: string, content: string): ToolParseResult {
	const name = toolNameFor(path);
	if (!name) return { error: `"${path}" has no usable tool name.` };

	const { frontmatter, body } = parseFrontmatter(content);
	const description =
		(typeof frontmatter?.description === 'string' && frontmatter.description.trim()) ||
		`Custom brain tool "${deslug(path)}".`;
	const displayTitle =
		(typeof frontmatter?.title === 'string' && frontmatter.title.trim()) || deslug(path);

	const fence = body.match(FENCE_RE);
	const instructionsBody = fence ? body.replace(FENCE_RE, '').trim() : body.trim();

	let spec: SpecParse = { params: [], opArgs: {}, widget: false, instructions: '' };
	if (fence) {
		spec = parseSpec(fence[1]);
		if (spec.error) return { error: `${path}: ${spec.error}` };
	}

	if (spec.op && spec.view) {
		return { error: `${path}: a tool can't be both an op and a view.` };
	}
	if (!spec.op && !spec.view && !instructionsBody) {
		return {
			error: `${path}: empty tool — add instructions, an "op:", or a "view:".`
		};
	}
	for (const p of spec.params) {
		if (!IDENT_RE.test(p.name)) {
			return { error: `${path}: input "${p.name}" is not a valid identifier.` };
		}
		if (p.name === 'brain') {
			return { error: `${path}: "brain" is a reserved input name.` };
		}
	}

	return {
		def: {
			name,
			displayTitle,
			description,
			sourcePath: path,
			params: spec.params,
			instructions: instructionsBody,
			op: spec.op,
			opArgs: spec.opArgs,
			view: spec.view,
			widget: spec.widget
		}
	};
}

// ---------- zod input shape ----------

// Build the MCP inputSchema (a ZodRawShape) for a tool's declared params, plus the
// standard optional `brain` selector every brain tool carries. Defaults make a
// param optional; an explicit `optional` does too.
export function zodShapeFor(params: ToolParam[]): Record<string, z.ZodTypeAny> {
	const shape: Record<string, z.ZodTypeAny> = {
		brain: z
			.string()
			.optional()
			.describe('Which brain to target (name/handle). Defaults to the active brain.')
	};
	for (const p of params) {
		let t: z.ZodTypeAny;
		switch (p.type) {
			case 'number':
				t = z.coerce.number();
				break;
			case 'boolean':
				t = z.coerce.boolean();
				break;
			case 'enum':
				t = z.enum(p.enumValues as [string, ...string[]]);
				break;
			default:
				t = z.string();
		}
		if (p.description) t = t.describe(p.description);
		if (p.default !== undefined) {
			const def: unknown =
				p.type === 'number'
					? Number(p.default)
					: p.type === 'boolean'
						? p.default === 'true'
						: p.default;
			t = t.default(def as never);
		} else if (p.optional) {
			t = t.optional();
		}
		shape[p.name] = t;
	}
	return shape;
}

// ---------- argument interpolation ----------

// Substitute {{name}} placeholders with argument VALUES. Pure text substitution —
// no expression evaluation — so a tool template can never execute code. Unknown
// placeholders become empty strings (fail-open, matching the view engine).
export function fill(template: string, args: Record<string, unknown>): string {
	return template.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (_, k: string) => {
		const v = args[k];
		return v === undefined || v === null ? '' : String(v);
	});
}
