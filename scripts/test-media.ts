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
//   3. relativeAssetHref, which decides whether the link we write into a page
//      resolves for github.com and for outside OKF readers. It is the one piece of
//      this that a human will never notice is wrong until a picture stops rendering
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
	defaultAttachmentPath,
	formatBytes,
	isModelViewable,
	isValidBase64,
	mediaTypeOf,
	validateAttachment
} from '../src/lib/media.ts';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
	if (cond) console.log(`  ✓ ${label}`);
	else {
		failures++;
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

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

console.log(failures === 0 ? '\nAll media checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
