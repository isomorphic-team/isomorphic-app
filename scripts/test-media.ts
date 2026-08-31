// Golden test for the media-attachment layer — pure, no network, no D1.
//
// What it is defending, in rough order of how expensive the bug would be:
//
//   1. The SIZE GATE. base64Bytes has to be right without decoding, because the
//      whole point is to reject a 60 MB paste before it becomes 60 MB of isolate
//      memory (the Worker has 128 MB). An off-by-a-third here either lets a payload
//      through that the host will refuse anyway, or rejects a legal 4 MB screenshot.
//   2. The EXTENSION/MIME AGREEMENT. These are read by different consumers later
//      (the extension by every git client, the MIME by the app and the model), and a
//      `.png` that is really a PDF fails at display time with no explanation.
//   3. The INSERTED LINK, which decides whether a picture resolves for github.com and
//      for outside OKF readers, and whether it survives a move_page unchanged. This is
//      the piece a human never notices is wrong until an image stops rendering
//      somewhere we do not test.
//   4. isAssetPath, the predicate the index uses to decide an image link is worth
//      recording — get it wrong in the permissive direction and validate starts
//      reporting stray links as broken.
//
//   pnpm test:media

import { parsePaths } from '../src/lib/brain-config.ts';
import { isAssetPath, isContentPath } from '../src/lib/brain-policy.ts';
import { relativeHref } from '../src/lib/wiki.ts';
import {
	MAX_ATTACHMENT_BYTES,
	attachmentMarkdown,
	attachmentSlug,
	base64Bytes,
	base64FromBytes,
	defaultAttachmentPath,
	extensionForType,
	fetchRemoteAttachment,
	fetchUrlProblem,
	filenameFromUrl,
	formatBytes,
	isEmbeddable,
	isModelViewable,
	isValidBase64,
	mediaTypeOf,
	normalizeContentType,
	uniqueAttachmentPath,
	validateAttachment
} from '../src/lib/media.ts';

import { checker } from './check.ts';

const { check, done } = checker('media checks');

// A 1x1 transparent PNG. Real bytes, so the size math is exercised against
// something that actually decodes rather than a string of 'A's.
const PNG_1PX =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

console.log('\nmime typing');
{
	check('png', mediaTypeOf('a/b/c.png') === 'image/png');
	check('jpg and jpeg agree', mediaTypeOf('x.jpg') === mediaTypeOf('x.jpeg'));
	check('uppercase extension still resolves', mediaTypeOf('SHOT.PNG') === 'image/png');
	check('unknown extension is not media', mediaTypeOf('notes.txt') === undefined);
	check('no extension is not media', mediaTypeOf('LICENSE') === undefined);
	// A dotfile has no extension by our rule; `lastIndexOf('.') <= 0` is what enforces
	// it, so `.gitkeep` must not read as a "gitkeep" type.
	check('dotfile is not media', mediaTypeOf('.gitkeep') === undefined);
	check('pdf is media but not model-viewable', mediaTypeOf('r.pdf') === 'application/pdf');
	check('svg is media but not model-viewable', !isModelViewable('image/svg+xml'));
	check('png is model-viewable', isModelViewable('image/png'));
	check('pdf is not model-viewable', !isModelViewable('application/pdf'));
}

console.log('\nbase64 size accounting (must be exact, and must not decode)');
{
	// "hi" -> aGk=  : 2 bytes, one pad char.
	check('one pad char', base64Bytes('aGk=') === 2, String(base64Bytes('aGk=')));
	// "h" -> aA==   : 1 byte, two pad chars.
	check('two pad chars', base64Bytes('aA==') === 1, String(base64Bytes('aA==')));
	// "abc" -> YWJj : 3 bytes, no padding.
	check('no padding', base64Bytes('YWJj') === 3, String(base64Bytes('YWJj')));
	check('empty is zero', base64Bytes('') === 0);
	// The real PNG: 70 bytes.
	check('1px png measures 70 bytes', base64Bytes(PNG_1PX) === 70, String(base64Bytes(PNG_1PX)));
	// Cross-check against an actual decode, so the formula cannot quietly drift.
	const decoded = Buffer.from(PNG_1PX, 'base64').length;
	check('formula agrees with a real decode', base64Bytes(PNG_1PX) === decoded);
	// Newlines are what GitHub's own base64 payloads carry; they must not inflate the count.
	const wrapped = PNG_1PX.replace(/(.{20})/g, '$1\n');
	check('embedded newlines do not inflate the count', base64Bytes(wrapped) === decoded);
}

console.log('\nbase64 validity');
{
	check('valid', isValidBase64(PNG_1PX));
	check('wrapped is still valid', isValidBase64(PNG_1PX.replace(/(.{20})/g, '$1\n')));
	check('rejects non-base64 characters', !isValidBase64('not base64!!'));
	check('rejects a truncated group', !isValidBase64('YWJjZ'));
	check('rejects empty', !isValidBase64(''));
	// A data: URL prefix is the single most likely thing a widget author sends by
	// accident, and it must not be silently stored as if it were the image.
	check('rejects a whole data: URL', !isValidBase64(`data:image/png;base64,${PNG_1PX}`));
}

console.log('\nvalidateAttachment');
{
	const ok = validateAttachment({
		path: 'wiki/assets/a.png',
		mimeType: 'image/png',
		data: PNG_1PX
	});
	check('accepts a well-formed png', ok === null, String(ok));

	const unknown = validateAttachment({
		path: 'wiki/assets/a.exe',
		mimeType: 'application/octet-stream',
		data: PNG_1PX
	});
	check('refuses an unsupported type', unknown !== null);
	check('and names what is supported', (unknown ?? '').includes('image/png'), String(unknown));

	const mismatch = validateAttachment({
		path: 'wiki/assets/a.png',
		mimeType: 'application/pdf',
		data: PNG_1PX
	});
	check('refuses extension/mime disagreement', mismatch !== null);

	const bad = validateAttachment({
		path: 'wiki/assets/a.png',
		mimeType: 'image/png',
		data: 'not base64!!'
	});
	check('refuses malformed base64', bad !== null);

	const empty = validateAttachment({ path: 'wiki/assets/a.png', mimeType: 'image/png', data: '' });
	check('refuses empty', empty !== null);

	// One base64 char over the cap. Built as a string rather than real bytes so the
	// test does not allocate 5 MiB to prove a size check.
	const oversize = 'A'.repeat(Math.ceil(((MAX_ATTACHMENT_BYTES + 1) * 4) / 3 / 4) * 4);
	const tooBig = validateAttachment({
		path: 'wiki/assets/big.png',
		mimeType: 'image/png',
		data: oversize
	});
	check('refuses over the cap', tooBig !== null, String(tooBig));
	check(
		'and explains the permanence, not just the number',
		(tooBig ?? '').includes('history'),
		String(tooBig)
	);
	check('cap is 5 MiB', MAX_ATTACHMENT_BYTES === 5 * 1024 * 1024);
	check('formatBytes reads like a size', formatBytes(MAX_ATTACHMENT_BYTES) === '5.0 MB');
}

console.log('\nfilenames and default placement');
{
	check(
		'slugs a messy filename',
		attachmentSlug('Screen Shot 2026.png') === 'screen-shot-2026.png'
	);
	check('lowercases the extension', attachmentSlug('A.PNG') === 'a.png');
	check(
		'strips leading/trailing junk, including from the extension',
		attachmentSlug('  --hi--.png  ') === 'hi.png',
		attachmentSlug('  --hi--.png  ')
	);
	// ".png" is a dotfile by the one extension rule in media.ts, not a nameless png, so
	// it keeps no extension and validateAttachment then refuses it. Asserted here
	// because the alternative (inventing "attachment.png") would store bytes under a
	// name the uploader never chose.
	check('a dotfile name keeps no extension', attachmentSlug('.png') === 'png');
	check(
		'and such a name is then refused rather than stored',
		validateAttachment({
			path: defaultAttachmentPath('wiki/a.md', '.png'),
			mimeType: 'image/png',
			data: PNG_1PX
		}) !== null
	);
	check('an empty name still yields something legal', attachmentSlug('') === 'attachment');
	check(
		'co-locates beside the page',
		defaultAttachmentPath('wiki/vendors/acme.md', 'Logo.png') === 'wiki/vendors/assets/logo.png'
	);
	check(
		'a root page still gets an assets folder',
		defaultAttachmentPath('index.md', 'a.png') === 'assets/a.png'
	);
}

console.log('\nnot overwriting an attachment that is already there');
{
	// Storing used to write straight over whatever occupied the path. Two screenshots
	// pasted a moment apart, or two people attaching "diagram.png" to the same page,
	// silently destroyed the first — and every page linking to it kept the same link,
	// so those pages quietly began showing a different picture.
	const free = uniqueAttachmentPath('wiki/a/assets/logo.png', () => false);
	check('a free path is used as-is', free === 'wiki/a/assets/logo.png', free);

	const taken = new Set(['wiki/a/assets/logo.png']);
	const second = uniqueAttachmentPath('wiki/a/assets/logo.png', (p) => taken.has(p));
	check(
		'a taken path is numbered, keeping the extension',
		second === 'wiki/a/assets/logo-2.png',
		second
	);

	taken.add('wiki/a/assets/logo-2.png');
	const third = uniqueAttachmentPath('wiki/a/assets/logo.png', (p) => taken.has(p));
	check(
		'and numbering continues past the first variant',
		third === 'wiki/a/assets/logo-3.png',
		third
	);

	// The extension has to survive, or the stored filename stops describing the bytes
	// and mediaTypeOf (which every reader trusts) starts answering wrong.
	check(
		'the numbered name still resolves to the same media type',
		mediaTypeOf(third) === mediaTypeOf('wiki/a/assets/logo.png')
	);

	// A dotfile has no extension to preserve — the leading dot is the name.
	const dotfile = uniqueAttachmentPath('wiki/a/.keep', (p) => p === 'wiki/a/.keep');
	check('a dotfile numbers without inventing an extension', dotfile === 'wiki/a/.keep-2', dotfile);

	// Exhaustion returns '' rather than looping or clobbering, so the tool can refuse.
	const exhausted = uniqueAttachmentPath('wiki/a/assets/logo.png', () => true);
	check('an exhausted name yields nothing rather than overwriting', exhausted === '', exhausted);
}

console.log('\nthe inserted link (what github.com and OKF readers follow)');
{
	// The generated markdown has to be ordinary image syntax: no Isomorphic extension,
	// or the page stops rendering everywhere except inside our own app.
	const md = attachmentMarkdown(
		'wiki/vendors/acme.md',
		'wiki/vendors/assets/logo.png',
		'Acme logo'
	);
	check('renders as plain markdown', md === '![Acme logo](assets/logo.png)', md);
	check(
		'up one level',
		attachmentMarkdown('wiki/vendors/deep/acme.md', 'wiki/vendors/assets/logo.png', 'x') ===
			'![x](../assets/logo.png)',
		attachmentMarkdown('wiki/vendors/deep/acme.md', 'wiki/vendors/assets/logo.png', 'x')
	);
	check(
		'up two levels',
		attachmentMarkdown('wiki/a/b/c.md', 'wiki/assets/logo.png', 'x') ===
			'![x](../../assets/logo.png)',
		attachmentMarkdown('wiki/a/b/c.md', 'wiki/assets/logo.png', 'x')
	);
	check(
		'brackets in alt text cannot break the link',
		attachmentMarkdown('a.md', 'assets/x.png', 'a [weird] name') === '![a weird name](assets/x.png)'
	);

	// The regression this pins, found by the e2e round trip: attachmentMarkdown wrote the
	// href one way and move_page's rewriteMdLinks (which goes through relativeHref) wrote
	// it another, so a link silently changed shape the first time its image was moved.
	// There must be exactly ONE way to spell the path.
	const cases: [string, string][] = [
		['wiki/vendors/acme.md', 'wiki/vendors/assets/logo.png'],
		['wiki/a/b/c.md', 'wiki/assets/logo.png'],
		['index.md', 'assets/logo.png']
	];
	const agree = cases.every(
		([page, asset]) => attachmentMarkdown(page, asset, 'x') === `![x](${relativeHref(page, asset)})`
	);
	check('the inserted href is the same one move_page would write', agree);

	// Images embed, documents link. `![](…)` on a PDF renders as a broken image in
	// every markdown reader including github.com — the embed syntax means "show this
	// picture", not "here is an attachment".
	check(
		'a pdf is linked, not embedded',
		attachmentMarkdown('wiki/a.md', 'wiki/assets/report.pdf', 'Q4 report') ===
			'[Q4 report](assets/report.pdf)',
		attachmentMarkdown('wiki/a.md', 'wiki/assets/report.pdf', 'Q4 report')
	);
	check(
		'an svg still embeds',
		attachmentMarkdown('wiki/a.md', 'assets/d.svg', 'd').startsWith('!')
	);
	check('a gif still embeds', attachmentMarkdown('wiki/a.md', 'assets/d.gif', 'd').startsWith('!'));
	check('isEmbeddable agrees for png', isEmbeddable('a/b.png'));
	check('isEmbeddable is false for pdf', !isEmbeddable('a/b.pdf'));
	check('isEmbeddable is false for a page', !isEmbeddable('a/b.md'));
}

console.log('\nisAssetPath (what the index will record as an attachment link)');
{
	const wiki = { paths: parsePaths({ contentRoots: ['wiki'], sourceRoots: ['raw'], logPath: '' }) };
	check('an image under content is an asset', isAssetPath('wiki/assets/a.png', wiki));
	check('a page is not an asset', !isAssetPath('wiki/a.md', wiki));
	check('an image under source is not an asset', !isAssetPath('raw/a.png', wiki));
	check('an image outside content is not an asset', !isAssetPath('elsewhere/a.png', wiki));
	// The media-type check is what stops this claiming arbitrary repo files.
	check('a stray yaml under content is not an asset', !isAssetPath('wiki/ci.yml', wiki));
	check('a dotfile is not an asset', !isAssetPath('wiki/.gitkeep', wiki));
	// Pages and assets must partition cleanly: nothing may be both, or a write tool
	// would have to decide which set of rules applies.
	const probes = ['wiki/a.md', 'wiki/assets/a.png', 'raw/x.png', 'wiki/.gitkeep', 'wiki/ci.yml'];
	const overlap = probes.filter((p) => isAssetPath(p, wiki) && p.endsWith('.md'));
	check('no path is both a page and an asset', overlap.length === 0, overlap.join(', '));
	// An asset is still "content" by role; that is what keeps it inside the brain's
	// editable region for permission purposes even though it is not a page.
	check('an asset is content by role', isContentPath('wiki/assets/a.png', wiki));

	const wholeRepo = { paths: parsePaths({ contentRoots: ['.'], sourceRoots: [], logPath: '' }) };
	check('whole-repo brain: root image is an asset', isAssetPath('logo.png', wholeRepo));
}

// ---------------------------------------------------------------------------
// URL ingest. The fetch is driven through an injected stub, so this stays a pure
// offline test while still covering the branches that matter most: the address
// guards (this is the one place a caller's string becomes an outbound request from
// our server) and the size cap (the only thing between a 5 MiB rule and an arbitrary
// download into a 128 MB isolate).
// ---------------------------------------------------------------------------

console.log('\nfetchUrlProblem (which addresses the server will fetch)');
{
	const ok = (u: string) => fetchUrlProblem(u) === null;
	check('a public https url is allowed', ok('https://example.com/floor-plan.png'));
	check('a port is not itself disqualifying', ok('https://example.com:8443/a.png'));
	check('http is refused', !ok('http://example.com/a.png'));
	check('file: is refused', !ok('file:///etc/passwd'));
	check('gibberish is refused', !ok('not a url'));
	check('credentials in the url are refused', !ok('https://user:pw@example.com/a.png'));

	check('localhost is refused', !ok('https://localhost/a.png'));
	check('127.0.0.1 is refused', !ok('https://127.0.0.1/a.png'));
	check('a .local host is refused', !ok('https://printer.local/a.png'));
	check('a .internal host is refused', !ok('https://vault.internal/a.png'));
	check('10/8 is refused', !ok('https://10.1.2.3/a.png'));
	check('172.16/12 is refused', !ok('https://172.20.0.5/a.png'));
	check('172.32 is NOT in that range', ok('https://172.32.0.5/a.png'));
	check('192.168/16 is refused', !ok('https://192.168.1.1/a.png'));
	check('carrier-grade NAT is refused', !ok('https://100.64.0.1/a.png'));
	// The one address that turns "fetch a URL" into a credential leak on most clouds.
	check('link-local metadata is refused', !ok('https://169.254.169.254/latest/meta-data/'));
	// The WHATWG parser normalizes these to dotted quads before we see them, which is
	// why the range check alone is enough and there is no decoding to do here.
	check('decimal-encoded 127.0.0.1 is refused', !ok('https://2130706433/a.png'));
	check('hex-encoded 127.0.0.1 is refused', !ok('https://0x7f000001/a.png'));
	check('ipv6 loopback is refused', !ok('https://[::1]/a.png'));
	check('ipv6 unique-local is refused', !ok('https://[fc00::1]/a.png'));
	check('ipv6 link-local is refused', !ok('https://[fe80::1]/a.png'));
	check('ipv4-mapped ipv6 loopback is refused', !ok('https://[::ffff:127.0.0.1]/a.png'));
	check('ipv4-mapped private space is refused', !ok('https://[::ffff:192.168.0.1]/a.png'));
	check('loopback written out in full is refused', !ok('https://[0:0:0:0:0:0:0:1]/a.png'));
	check('a public ipv6 address is allowed', ok('https://[2606:4700::1111]/a.png'));
	check('an ipv4-mapped PUBLIC address is allowed', ok('https://[::ffff:8.8.8.8]/a.png'));
}

console.log('\nfilename and type derivation');
{
	check(
		'filename from the path',
		filenameFromUrl('https://e.com/a/floor-plan.png') === 'floor-plan.png'
	);
	check('query string is not part of it', filenameFromUrl('https://e.com/a.png?v=2') === 'a.png');
	check(
		'percent escapes are decoded',
		filenameFromUrl('https://e.com/floor%20plan.png') === 'floor plan.png'
	);
	check('a bare host has no filename', filenameFromUrl('https://e.com/') === '');
	check('type -> extension picks jpg over jpeg', extensionForType('image/jpeg') === 'jpg');
	check('type -> extension for png', extensionForType('image/png') === 'png');
	check('an unknown type has no extension', extensionForType('text/html') === undefined);
	check(
		'content-type parameters are dropped',
		normalizeContentType('image/png; charset=binary') === 'image/png'
	);
	check('content-type case is normalized', normalizeContentType('IMAGE/PNG') === 'image/png');
	check('image/jpg folds onto image/jpeg', normalizeContentType('image/jpg') === 'image/jpeg');
	check('a missing content-type is empty', normalizeContentType(null) === '');

	const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
	check(
		'base64FromBytes round-trips',
		base64FromBytes(bytes) === Buffer.from(bytes).toString('base64')
	);
	// The chunking exists so a multi-MB file does not spread past the argument limit.
	const big = new Uint8Array(200_000).map((_, i) => i % 251);
	check(
		'base64FromBytes survives a large buffer',
		base64FromBytes(big) === Buffer.from(big).toString('base64')
	);
}

console.log('\nfetchRemoteAttachment');
{
	const PNG_BYTES = Buffer.from(PNG_1PX, 'base64');

	// A stub standing in for the network. Records what was requested, so a test can
	// assert the guards ran BEFORE anything went out.
	function stub(routes: Record<string, () => Response>) {
		const seen: string[] = [];
		const impl = (async (input: string | URL) => {
			const u = String(input);
			seen.push(u);
			const make = routes[u];
			if (!make) throw new Error(`unrouted: ${u}`);
			return make();
		}) as unknown as typeof fetch;
		return { impl, seen };
	}
	const png = (headers: Record<string, string> = {}) =>
		new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png', ...headers } });
	const streamed = (chunks: Uint8Array[], headers: Record<string, string> = {}) =>
		new Response(
			new ReadableStream({
				start(c) {
					for (const chunk of chunks) c.enqueue(chunk);
					c.close();
				}
			}),
			{ status: 200, headers: { 'content-type': 'image/png', ...headers } }
		);

	{
		const { impl } = stub({ 'https://e.com/plan.png': () => png() });
		const r = await fetchRemoteAttachment('https://e.com/plan.png', { fetchImpl: impl });
		check('a plain png comes back', !('error' in r), JSON.stringify(r));
		if (!('error' in r)) {
			check('bytes match the source', r.data === PNG_1PX);
			check('size is the decoded length', r.bytes === PNG_BYTES.length);
			check('type comes from the response', r.mimeType === 'image/png');
			check('filename comes from the url', r.filename === 'plan.png');
		}
	}
	{
		// No extension in the URL: the served type has to name the file.
		const { impl } = stub({ 'https://e.com/download?id=9': () => png() });
		const r = await fetchRemoteAttachment('https://e.com/download?id=9', { fetchImpl: impl });
		check(
			'an extensionless url is named from its content-type',
			!('error' in r) && r.filename === 'download.png'
		);
	}
	{
		const { impl } = stub({ 'https://e.com/plan.png': () => png() });
		const r = await fetchRemoteAttachment('https://e.com/plan.png', {
			fetchImpl: impl,
			filename: 'venue-floor-plan.png'
		});
		check(
			'a caller-supplied filename wins',
			!('error' in r) && r.filename === 'venue-floor-plan.png'
		);
	}
	{
		// The common failure: a URL that answers with a login wall or an error page.
		const { impl } = stub({
			'https://e.com/plan.png': () =>
				new Response('<html>sign in</html>', {
					status: 200,
					headers: { 'content-type': 'text/html' }
				})
		});
		const r = await fetchRemoteAttachment('https://e.com/plan.png', { fetchImpl: impl });
		check('html served as a .png is refused', 'error' in r, JSON.stringify(r));
	}
	{
		const { impl } = stub({
			'https://e.com/a': () =>
				new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })
		});
		const r = await fetchRemoteAttachment('https://e.com/a', { fetchImpl: impl });
		check('a 404 is reported, not stored', 'error' in r && r.error.includes('404'));
	}
	{
		const { impl } = stub({
			'https://e.com/empty.png': () =>
				new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'image/png' } })
		});
		const r = await fetchRemoteAttachment('https://e.com/empty.png', { fetchImpl: impl });
		check('an empty response is refused', 'error' in r);
	}
	{
		// Content-Length tells the truth: refuse without downloading.
		const { impl } = stub({
			'https://e.com/huge.png': () => png({ 'content-length': String(MAX_ATTACHMENT_BYTES + 1) })
		});
		const r = await fetchRemoteAttachment('https://e.com/huge.png', { fetchImpl: impl });
		check('an oversized content-length is refused up front', 'error' in r);
	}
	{
		// Content-Length is absent, so only the streaming cap stands between us and the
		// whole file. Six 1 MiB chunks against a 5 MiB limit.
		const chunk = new Uint8Array(1024 * 1024);
		const { impl } = stub({
			'https://e.com/big.png': () => streamed([chunk, chunk, chunk, chunk, chunk, chunk])
		});
		const r = await fetchRemoteAttachment('https://e.com/big.png', { fetchImpl: impl });
		check('a body that outgrows the cap mid-stream is refused', 'error' in r, JSON.stringify(r));
	}
	{
		const chunk = new Uint8Array(1024);
		const { impl } = stub({ 'https://e.com/small.png': () => streamed([chunk, chunk]) });
		const r = await fetchRemoteAttachment('https://e.com/small.png', { fetchImpl: impl });
		check('a streamed body under the cap is assembled', !('error' in r) && r.bytes === 2048);
	}
	{
		const { impl, seen } = stub({
			'https://e.com/go': () =>
				new Response(null, { status: 302, headers: { location: '/real/plan.png' } }),
			'https://e.com/real/plan.png': () => png()
		});
		const r = await fetchRemoteAttachment('https://e.com/go', { fetchImpl: impl });
		check('a redirect is followed', !('error' in r), JSON.stringify(r));
		// The name comes from where it landed, not from where it was asked for, or a
		// redirect through a share link stores the file as "go".
		check('the filename comes from the final url', !('error' in r) && r.filename === 'plan.png');
		check('both hops were fetched', seen.length === 2);
	}
	{
		// The reason redirects are followed by hand: `redirect: 'follow'` would check
		// the first address and then let a 302 point anywhere it liked.
		const { impl, seen } = stub({
			'https://e.com/go': () =>
				new Response(null, {
					status: 302,
					headers: { location: 'https://169.254.169.254/latest/meta-data/' }
				})
		});
		const r = await fetchRemoteAttachment('https://e.com/go', { fetchImpl: impl });
		check('a redirect into link-local is refused', 'error' in r);
		check('the redirect target was never requested', seen.length === 1, seen.join(', '));
	}
	{
		const { impl } = stub({
			'https://e.com/a': () => new Response(null, { status: 302, headers: { location: '/b' } }),
			'https://e.com/b': () => new Response(null, { status: 302, headers: { location: '/c' } }),
			'https://e.com/c': () => new Response(null, { status: 302, headers: { location: '/d' } }),
			'https://e.com/d': () => new Response(null, { status: 302, headers: { location: '/e' } }),
			'https://e.com/e': () => png()
		});
		const r = await fetchRemoteAttachment('https://e.com/a', { fetchImpl: impl });
		check('a redirect chain is bounded', 'error' in r);
	}
	{
		const { impl, seen } = stub({});
		const r = await fetchRemoteAttachment('https://127.0.0.1/a.png', { fetchImpl: impl });
		check('a blocked address never reaches the network', 'error' in r && seen.length === 0);
	}
	{
		const { impl } = stub({
			'https://e.com/x.png': () => {
				throw new Error('getaddrinfo ENOTFOUND');
			}
		});
		const r = await fetchRemoteAttachment('https://e.com/x.png', { fetchImpl: impl });
		check('a transport failure is an error, not a throw', 'error' in r);
	}
	{
		// The fetched file still has to satisfy the same rule an upload does, because
		// the destination path is what every later reader goes by.
		const { impl } = stub({ 'https://e.com/plan.png': () => png() });
		const r = await fetchRemoteAttachment('https://e.com/plan.png', { fetchImpl: impl });
		const problem =
			'error' in r
				? 'fetch failed'
				: validateAttachment({ path: 'wiki/assets/plan.png', mimeType: r.mimeType, data: r.data });
		check('a fetched attachment passes validateAttachment', problem === null, String(problem));
	}
}

done();
