// One markdown renderer, for every surface that shows a page.
//
// Pure and Worker-safe (no `node:*`, no DOM), so the app bundle and the Worker
// produce identical HTML from the same body. That is the whole reason it lives
// here rather than in `app/`: a second surface rendering pages needs the same
// output, and a second implementation of it would drift exactly the way
// `wikilinkKey` and `FOLDER_NOTE_NAMES` drifted before they were extracted.
//
// It also SANITIZES, which the app never did. `marked` performs no sanitization
// of any kind (verified against v18): `<script>`, `<iframe>`, `onerror=`, and
// `javascript:` hrefs all pass through verbatim. Inside the MCP App that is
// bounded by the host iframe's CSP and by the fact that the author already has
// write access to the brain. Served from our own origin next to a session
// cookie, the same body is stored XSS against every reader. The policy below is
// the boundary, so treat every change to it as a security change.

import { Marked, Renderer, type Tokens } from 'marked';
import { maskCode } from './wiki.ts';

// ---------- policy ----------

// Raw HTML tags kept as-is. Everything else is escaped and shows as text.
//
// The list is formatting only. Anything that can load, execute, or navigate is
// absent on purpose: `script`, `style`, `iframe`, `object`, `embed`, `form`,
// `input`, `button`, `base`, `link`, `meta`, `svg`, `math`.
//
// `a` and `img` are absent too, which is the non-obvious one. Markdown's own
// link and image syntax goes through `link()`/`image()` below, where the scheme
// is checked; a raw `<a href="javascript:...">` would walk straight past that.
// So a raw anchor renders as text, and the author writes a markdown link.
const SAFE_TAGS: ReadonlySet<string> = new Set([
	// inline formatting
	'b',
	'strong',
	'i',
	'em',
	'u',
	's',
	'strike',
	'del',
	'ins',
	'mark',
	'small',
	'sub',
	'sup',
	'kbd',
	'samp',
	'var',
	'code',
	'abbr',
	'cite',
	'q',
	'dfn',
	'time',
	'ruby',
	'rt',
	'rp',
	'bdi',
	'bdo',
	// breaks
	'br',
	'wbr',
	'hr',
	// blocks
	'p',
	'div',
	'span',
	'blockquote',
	'pre',
	'section',
	'article',
	'aside',
	'header',
	'footer',
	'figure',
	'figcaption',
	'details',
	'summary',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	// lists
	'ul',
	'ol',
	'li',
	'dl',
	'dt',
	'dd',
	// tables
	'table',
	'thead',
	'tbody',
	'tfoot',
	'tr',
	'td',
	'th',
	'caption',
	'colgroup',
	'col'
]);

// URL schemes a link or image may use. A relative path, a bare anchor, and a
// protocol-relative `//host` carry no scheme and are always allowed.
//
// `data:` is absent: `data:text/html` is a script vector, and an inline image
// has no reason to reach a page body (attachments arrive through `read_media`
// in the app, and through the asset route on a web surface).
const SAFE_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel']);

// The sentinel a `[[wikilink]]` becomes between the pre-pass and the renderer.
// It is a scheme rather than a fragment so it cannot collide with an anchor an
// author wrote by hand, and `marked` leaves percent-escapes in it intact.
const WIKILINK_SCHEME = 'wikilink:';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

// ---------- escaping ----------

const HTML_ESCAPES: Readonly<Record<string, string>> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Named entities that can smuggle a scheme past a naive check. Only the ones
// that matter: a colon separates the scheme, and the whitespace names are
// stripped by browsers while parsing one.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	colon: ':',
	tab: '\t',
	newline: '\n',
	sol: '/',
	lpar: '(',
	rpar: ')',
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'"
};

// Decode enough of an href for `isSafeUrl` to see what a browser will see.
//
// This exists because `marked` emits an href verbatim, so `&#106;avascript:`
// and `javascript&colon;` both reach the browser as `javascript:` while a
// scheme test on the raw string sees no scheme at all. Both are live bypasses
// without this; `pnpm test:render` pins them.
function decodeEntities(url: string): string {
	return url.replace(/&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z]+);?/g, (whole, body: string) => {
		if (body[0] === '#') {
			const code =
				body[1] === 'x' || body[1] === 'X'
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: whole;
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
	});
}

// Drop ASCII control characters and spaces. Written as a code-point filter
// rather than a regex range so the source stays plain ASCII: a literal control
// character inside a character class is invisible in review and turns the file
// binary to `grep`.
function stripBlanks(text: string): string {
	let out = '';
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (code > 0x20 && code !== 0x7f) out += ch;
	}
	return out;
}

// May a browser follow this URL from a page we served?
export function isSafeUrl(url: string): boolean {
	// Browsers ignore ASCII control characters and whitespace while parsing a
	// scheme, so they have to come out before the scheme is read.
	const bare = stripBlanks(decodeEntities(url));
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(bare);
	// No scheme: relative, anchor, or protocol-relative. Nothing to refuse.
	if (!scheme) return true;
	return SAFE_SCHEMES.has(scheme[1].toLowerCase());
}

// ---------- raw HTML ----------

// One tag, well formed: `<name attrs>` or `</name>`. Attribute values may hold
// `>` inside quotes, which is why the body alternation is quote-aware.
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

// Apply the tag allowlist to a chunk of raw HTML.
//
// Kept tags are re-emitted with NO attributes. That single rule is what makes
// the allowlist safe to read: with no attributes there is no `on*` handler, no
// `style`, and no `href`/`src`, so a tag on the list cannot carry a payload
// however it was written. `<div align="center">` therefore loses its alignment,
// which is a rendering change and never a silent security hole.
//
// Everything else, including any text between tags, is escaped rather than
// dropped. Escaping never changes what a page MEANS: an unsupported tag becomes
// visible to its author instead of quietly disappearing, and a stray `<`
// becomes `&lt;` rather than opening something.
export function sanitizeRawHtml(html: string): string {
	// Comments are dropped rather than escaped: they are invisible today, and
	// escaping one would print it onto the page.
	const source = html.replace(COMMENT_RE, '');
	let out = '';
	let last = 0;
	for (const m of source.matchAll(TAG_RE)) {
		const [whole, closing, name, attrs] = m;
		out += escapeHtml(source.slice(last, m.index));
		last = m.index + whole.length;
		// A self-closing marker is not an attribute.
		const bare = attrs.replace(/\/\s*$/, '').trim() === '';
		if (SAFE_TAGS.has(name.toLowerCase()) && bare) {
			const selfClosing = /\/\s*$/.test(attrs) ? ' /' : '';
			out += `<${closing}${name.toLowerCase()}${selfClosing}>`;
		} else {
			out += escapeHtml(whole);
		}
	}
	return out + escapeHtml(source.slice(last));
}

// ---------- rendering ----------

export interface RenderOptions {
	// Where a `[[wikilink]]` points. Returning null flattens it to its label.
	//
	// The app resolves on click, so its default returns the `#wikilink=`
	// sentinel that `onProseClick` reads. A server surface resolves at render
	// time and returns a real URL, or null when the target is outside what the
	// reader may see.
	wikilink?: (target: string) => string | null;
	// Where a markdown link points. Returning null FLATTENS it: the anchor goes
	// away and the link text stays. That is the reader's horizon rule, and it
	// flattens rather than 404s because a dead link still advertises the title
	// and the existence of a page the reader was not given.
	href?: (href: string) => string | null;
	// Where an image loads from. Returning null drops the image and keeps its
	// alt text. The app leaves this alone and swaps in data URIs from
	// `read_media` after render, keying off the `src` this emits.
	image?: (src: string) => string | null;
}

const defaultWikilink = (target: string) => `#wikilink=${encodeURIComponent(target)}`;

// The overrides `marked` merges over its own renderer.
//
// A plain object closing over `opts`, not a Renderer subclass, because
// `Marked.use` walks the renderer with `for...in` and throws on any property
// that is not a renderer method (so an `opts` field is a hard error), then
// invokes each override with ITS OWN renderer as `this` (so an instance field
// would not be there to read anyway).
//
// Returning `false` is `marked`'s documented "fall back to the default", and it
// runs the default against the SAME token object. So the way to change a link
// is to set `token.href` and hand it back: the default emits it, and this
// module never has to reproduce marked's attribute formatting or escaping.
function overrides(opts: RenderOptions) {
	return {
		// Raw HTML, block level and inline. Both token shapes carry `text`.
		html({ text }: Tokens.HTML | Tokens.Tag): string {
			return sanitizeRawHtml(text);
		},

		link(this: Renderer, token: Tokens.Link): string | false {
			const raw = token.href ?? '';
			const flatten = () => this.parser.parseInline(token.tokens);

			if (raw.startsWith(WIKILINK_SCHEME)) {
				const target = decodeURIComponent(raw.slice(WIKILINK_SCHEME.length));
				const to = (opts.wikilink ?? defaultWikilink)(target);
				// A wikilink that resolves to nothing renders as its label. In the
				// app an unresolvable one still gets the sentinel and reports
				// itself on click; on a server surface there is nobody to tell,
				// and no syntax the reader could act on.
				if (to === null || !isSafeUrl(to)) return flatten();
				token.href = to;
				return false;
			}

			const mapped = opts.href ? opts.href(raw) : raw;
			if (mapped === null || !isSafeUrl(mapped)) return flatten();
			token.href = mapped;
			return false;
		},

		image(token: Tokens.Image): string | false {
			const raw = token.href ?? '';
			const mapped = opts.image ? opts.image(raw) : raw;
			// No anchor to flatten to, so an image we will not load becomes its
			// alt text, which is what alt text is for.
			if (mapped === null || !isSafeUrl(mapped)) return escapeHtml(token.text ?? '');
			token.href = mapped;
			return false;
		}
	};
}

// Turn `[[Target|Label]]` into a link `marked` can tokenize, outside code.
//
// Masked rather than a plain replace: `[[Name]]` inside a fence or backticks on
// a conventions page is a syntax example, and rewriting it printed
// `[Name](#wikilink=Name)` into the code block. `extractLinks` already skips
// code for the same reason, through the same helper, so the renderer and the
// link graph agree on what counts as a link.
function linkifyWikilinks(body: string): string {
	const masked = maskCode(body);
	let out = '';
	let last = 0;
	for (const m of masked.matchAll(WIKILINK_RE)) {
		const [whole, target, label] = m;
		out += body.slice(last, m.index);
		last = m.index + whole.length;
		const text = (label || target).trim();
		out += `[${text}](${WIKILINK_SCHEME}${encodeURIComponent(target.trim())})`;
	}
	return out + body.slice(last);
}

// Markdown to HTML, sanitized, with links routed through `opts`.
export function renderMarkdown(body: string, opts: RenderOptions = {}): string {
	const md = new Marked({ renderer: overrides(opts), async: false });
	const html = md.parse(linkifyWikilinks(body), { async: false }) as string;
	// `marked` emits a literal space between a task-list checkbox and its label
	// (`<input type="checkbox"> Text`). Drop it so the gap is governed purely by
	// CSS (`margin-right`), matching the editor's flex `gap` exactly. Otherwise
	// the viewer reads 0.4em + a space and the box-to-text spacing visibly
	// shifts between modes.
	return html.replace(/(<input\b[^>]*\btype="checkbox"[^>]*>) /g, '$1');
}
