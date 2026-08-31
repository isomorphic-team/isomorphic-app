// Golden test for the one markdown renderer (src/lib/render.ts). Pure: no D1,
// no network, no DOM.
//
//   pnpm test:render
//
// Two jobs, and the second is a security boundary.
//
// 1. PARITY. The app and any server surface render a page through the same
//    function, so the constructs below pin the HTML the viewer already shows.
//    A change that alters them is a change to every page in every brain.
//
// 2. SANITIZATION. `marked` sanitizes nothing at all (verified against v18:
//    `<script>`, `<iframe>`, `onerror=`, and `javascript:` hrefs all pass
//    through verbatim). The app rendered that straight into
//    `dangerouslySetInnerHTML`, which the host iframe's CSP bounded; served
//    from our own origin beside a session cookie it is stored XSS. Every
//    payload below is one that reached the browser before this module existed.
//
// Break the sanitizer deliberately and confirm this goes red before believing
// it: a test that passes against both the old and the new behaviour is testing
// neither.

import { renderMarkdown, isSafeUrl, sanitizeRawHtml } from '../src/lib/render.ts';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

// Nothing a browser will execute or fetch off-origin survived the render.
//
// Only REAL tags are inspected. A payload that was escaped shows up in the
// output as text (`&lt;img src=x onerror=…&gt;`), which still contains the
// substring ` onerror=` while being inert by construction, so a scan over the
// whole string reports danger where there is none.
function inert(html: string): boolean {
	for (const raw of html.match(/<[^>]*>/g) ?? []) {
		// What the BROWSER sees, not what we wrote: an href of
		// `&#106;avascript:` is followed as `javascript:`, so a scheme test on
		// the undecoded attribute reports safety that is not there. Without this
		// the entity cases below pass even with the decoder torn out.
		const tag = raw.replace(/&(#[Xx][0-9A-Fa-f]+|#\d+|colon);?/g, (whole, body: string) => {
			if (body === 'colon') return ':';
			const code =
				body[1] === 'x' || body[1] === 'X'
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		});
		if (/^<\/?(script|iframe|style|object|embed|form|input|svg|math|base|link|meta)\b/i.test(tag)) {
			// `<input>` is the one marked emits itself, for a task list.
			if (!/^<input\b[^>]*\btype="checkbox"/.test(tag)) return false;
		}
		if (/\son\w+\s*=/i.test(tag)) return false;
		if (/(href|src)\s*=\s*["']?\s*(javascript|vbscript|data):/i.test(tag)) return false;
	}
	return true;
}

// ---------- parity: what the viewer already renders ----------

{
	console.log('\nparity');

	check(
		'a paragraph',
		renderMarkdown('Hello **world**.') === '<p>Hello <strong>world</strong>.</p>\n'
	);
	check(
		'a relative page link keeps its href',
		renderMarkdown('[a](./b.md)') === '<p><a href="./b.md">a</a></p>\n'
	);
	check(
		'an external link keeps its href',
		renderMarkdown('[a](https://example.com)') === '<p><a href="https://example.com">a</a></p>\n'
	);
	check(
		'an image keeps its repo-relative src for media.ts to swap',
		renderMarkdown('![alt](assets/x.png)') === '<p><img src="assets/x.png" alt="alt"></p>\n'
	);
	// The fixup exists so the checkbox-to-label gap is governed purely by CSS and
	// does not shift between the viewer and the editor.
	const task = renderMarkdown('- [ ] todo');
	check(
		'a task list drops the literal space after the checkbox',
		/"checkbox">todo/.test(task),
		task
	);

	// Tables, code and headings are the rest of what a page is made of.
	check('a fenced code block survives', /<pre><code/.test(renderMarkdown('```\nx\n```')));
	check('a heading survives', renderMarkdown('# Hi') === '<h1>Hi</h1>\n');
}

// ---------- wikilinks ----------

{
	console.log('\nwikilinks');

	// The default has to stay byte-identical to what `onProseClick` parses, or
	// every wikilink in the app stops navigating.
	check(
		'the default target is the sentinel onProseClick reads',
		renderMarkdown('See [[Weekly Sync]].') ===
			'<p>See <a href="#wikilink=Weekly%20Sync">Weekly Sync</a>.</p>\n'
	);
	check(
		'a piped label renders the label and links the target',
		renderMarkdown('[[Weekly Sync|the sync]]') ===
			'<p><a href="#wikilink=Weekly%20Sync">the sync</a></p>\n'
	);

	// A conventions page explaining the syntax is the case this protects: the
	// old string pre-pass rewrote inside fences, so the code block displayed
	// `[Name](#wikilink=Name)` instead of what the author typed.
	const fenced = renderMarkdown('```\n[[Name]]\n```');
	check('a wikilink inside a fence is left alone', /\[\[Name\]\]/.test(fenced), fenced);
	const inline = renderMarkdown('Write `[[Name]]` to link.');
	check('a wikilink inside backticks is left alone', /\[\[Name\]\]/.test(inline), inline);

	// A server surface resolves at render time instead. Note that marked
	// percent-encodes whatever the hook returns, so a hook may hand back a plain
	// path and does not have to pre-encode it.
	check(
		'the wikilink hook can rewrite the target, and marked encodes it',
		renderMarkdown('[[Weekly Sync]]', { wikilink: (t) => `/b/${t.toLowerCase()}` }) ===
			'<p><a href="/b/weekly%20sync">Weekly Sync</a></p>\n'
	);
	check(
		'a wikilink the hook cannot resolve flattens to its label',
		renderMarkdown('[[Gone]]', { wikilink: () => null }) === '<p>Gone</p>\n'
	);
}

// ---------- the link horizon ----------

{
	console.log('\nlink horizon');

	// Flattening rather than 404ing is the rule: a dead link still advertises
	// the title and the existence of a page the reader was not given.
	const out = renderMarkdown('[Secret roadmap](./secret.md)', { href: () => null });
	check('a link outside the horizon loses its anchor', !/<a\b/.test(out), out);
	check('a link outside the horizon keeps its text', /Secret roadmap/.test(out), out);
	check(
		'a link inside the horizon is rewritten',
		renderMarkdown('[a](./b.md)', { href: (h) => `/s/abc${h.slice(1)}` }) ===
			'<p><a href="/s/abc/b.md">a</a></p>\n'
	);
	check(
		'an image the hook refuses falls back to its alt text',
		renderMarkdown('![a diagram](assets/x.png)', { image: () => null }) === '<p>a diagram</p>\n'
	);
}

// ---------- sanitization: raw HTML ----------

{
	console.log('\nsanitization (raw HTML)');

	for (const [name, md] of [
		['a script block', '<script>alert(1)</script>'],
		['an inline script', 'hi <script>alert(1)</script> there'],
		['an iframe', '<iframe src="https://evil.com"></iframe>'],
		['a style block', '<style>body{display:none}</style>'],
		['an event handler on an img', 'hi <img src=x onerror=alert(1)> there'],
		['an event handler on an allowed tag', '<b onmouseover="alert(1)">x</b>'],
		['an object', '<object data="evil.swf"></object>'],
		['a form', '<form action="https://evil.com"><input name="a"></form>'],
		['a raw anchor carrying javascript', '<a href="javascript:alert(1)">x</a>'],
		['an svg with a handler', '<svg onload="alert(1)"></svg>'],
		['a malformed tag', '<div<script>alert(1)</script>']
	] as [string, string][]) {
		const html = renderMarkdown(md);
		check(`${name} comes back inert`, inert(html), html);
	}

	// The allowlist is what keeps ordinary formatting working, so pin both
	// directions: a listed tag survives, the same tag with an attribute does not.
	check('<br> survives', /<br>/.test(renderMarkdown('a<br>b')));
	check(
		'<details> survives',
		/<details>/.test(renderMarkdown('<details><summary>s</summary>b</details>'))
	);
	check('<sub> survives', /<sub>/.test(renderMarkdown('H<sub>2</sub>O')));
	check(
		'an allowed tag carrying an attribute is escaped, not kept',
		renderMarkdown('<div align="center">x</div>').includes('&lt;div align=&quot;center&quot;&gt;')
	);
	check(
		'an unsupported tag shows as text rather than disappearing',
		renderMarkdown('<script>alert(1)</script>').includes('&lt;script&gt;')
	);
	check('an HTML comment is dropped', !/comment/.test(renderMarkdown('<!-- comment -->')));
	check(
		'a self-closing allowed tag survives',
		/<br \/>/.test(sanitizeRawHtml('<br/>')),
		sanitizeRawHtml('<br/>')
	);
}

// ---------- sanitization: URL schemes ----------

{
	console.log('\nsanitization (URL schemes)');

	for (const [name, md] of [
		['a javascript: link', '[click](javascript:alert(1))'],
		['a mixed-case javascript: link', '[click](JaVaScRiPt:alert(1))'],
		['a vbscript: link', '[click](vbscript:msgbox(1))'],
		['a data: link', '[click](data:text/html,xx)'],
		['a javascript: image', '![x](javascript:alert(1))'],
		// Both of these reach the browser as `javascript:` while a scheme test on
		// the raw string sees no scheme at all. They were live bypasses.
		['a numeric-entity javascript: link', '[click](&#106;avascript:alert(1))'],
		['a named-entity javascript: link', '[click](javascript&colon;alert(1))'],
		['a hex-entity javascript: link', '[click](&#x6a;avascript:alert(1))']
	] as [string, string][]) {
		const html = renderMarkdown(md);
		check(`${name} comes back inert`, inert(html), html);
		check(`${name} keeps its text`, /click|x/.test(html), html);
	}

	// The scheme rule on its own, so a failure names the cause rather than a
	// rendered string.
	check('relative paths are safe', isSafeUrl('./a.md') && isSafeUrl('../a.md'));
	check('anchors are safe', isSafeUrl('#section'));
	check('protocol-relative is safe', isSafeUrl('//example.com/a'));
	check('http and https are safe', isSafeUrl('http://x') && isSafeUrl('https://x'));
	check('mailto and tel are safe', isSafeUrl('mailto:a@b.c') && isSafeUrl('tel:+15550100'));
	check('javascript is not', !isSafeUrl('javascript:alert(1)'));
	check('a padded javascript is not', !isSafeUrl('  javascript:alert(1)'));
	check('an entity-encoded javascript is not', !isSafeUrl('&#106;avascript:alert(1)'));
	check('vbscript is not', !isSafeUrl('vbscript:x'));
	check('data is not', !isSafeUrl('data:text/html,x'));
	check('file is not', !isSafeUrl('file:///etc/passwd'));
}

console.log(failures === 0 ? '\nAll render checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
