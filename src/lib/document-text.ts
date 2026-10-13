// The text inside an attached document (PDF, DOCX, PPTX), so read_media can hand an
// agent something to reason over on any host, with or without a shell.
//
// Worker-only: the app never imports this, which keeps pdf.js out of the ui:// bundle.
// No `node:*`. Text only: layout, images and formatting are not reproduced, and a
// scanned PDF with no text layer extracts as empty pages (there is no OCR).

import { unzipSync } from 'fflate';
import { DOCX_TYPE, PDF_TYPE, PPTX_TYPE } from './media.ts';

// What one part of the document is called in a reply: a PDF has pages, a deck has
// slides, and a Word file has no stable pages, so it is cut into sections.
export type DocumentUnit = 'page' | 'slide' | 'section';

export interface DocumentText {
	unit: DocumentUnit;
	parts: string[];
}

// A DOCX or PPTX is a zip, and a 5 MiB zip can inflate to gigabytes. Each entry we
// read is capped on its declared size before it is inflated, and the total too.
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;

// A DOCX section is cut at a paragraph boundary near this many characters.
const SECTION_CHARS = 4000;

export async function extractDocumentText(
	bytes: Uint8Array,
	mimeType: string
): Promise<DocumentText> {
	if (mimeType === PDF_TYPE) return { unit: 'page', parts: await pdfPages(bytes) };
	if (mimeType === DOCX_TYPE) return { unit: 'section', parts: docxSections(bytes) };
	if (mimeType === PPTX_TYPE) return { unit: 'slide', parts: pptxSlides(bytes) };
	throw new Error(`No text extraction for ${mimeType}.`);
}

async function pdfPages(bytes: Uint8Array): Promise<string[]> {
	// Loaded on first use so a request that never reads a PDF never evaluates pdf.js.
	const { extractText, getDocumentProxy } = await import('unpdf');
	const doc = await getDocumentProxy(bytes);
	try {
		const { text } = await extractText(doc, { mergePages: false });
		return text.map((t) => t.replace(/[ \t]+\n/g, '\n').trim());
	} finally {
		await doc.cleanup();
	}
}

function unzipEntries(bytes: Uint8Array, want: (name: string) => boolean): Map<string, string> {
	let total = 0;
	let tooBig = '';
	const files = unzipSync(bytes, {
		filter: (f) => {
			if (!want(f.name)) return false;
			total += f.originalSize;
			if (f.originalSize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) {
				tooBig = f.name;
				return false;
			}
			return true;
		}
	});
	if (tooBig)
		throw new Error(`The document is too large to read (${tooBig} inflates past the limit).`);
	const decoder = new TextDecoder();
	const out = new Map<string, string>();
	for (const [name, data] of Object.entries(files)) out.set(name, decoder.decode(data));
	return out;
}

export function decodeXmlEntities(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
		if (e === 'amp') return '&';
		if (e === 'lt') return '<';
		if (e === 'gt') return '>';
		if (e === 'quot') return '"';
		if (e === 'apos') return "'";
		const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
		try {
			return String.fromCodePoint(code);
		} catch {
			return m;
		}
	});
}

// Paragraphs of an OOXML part. `ns` is the text namespace prefix: `w` for Word, `a`
// for DrawingML (slides and notes). Runs inside a paragraph are joined as written;
// tabs and line breaks keep their meaning.
export function ooxmlParagraphs(xml: string, ns: 'w' | 'a'): string[] {
	const paraRe = new RegExp(`<${ns}:p[\\s>][\\s\\S]*?</${ns}:p>|<${ns}:p/>`, 'g');
	const tokenRe = new RegExp(
		`<${ns}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:t>|<${ns}:tab/>|<${ns}:br(?:\\s[^>]*)?/>`,
		'g'
	);
	const out: string[] = [];
	for (const para of xml.match(paraRe) ?? []) {
		let text = '';
		for (const tok of para.matchAll(tokenRe)) {
			if (tok[1] !== undefined) text += decodeXmlEntities(tok[1]);
			else if (tok[0].includes(':tab')) text += '\t';
			else text += '\n';
		}
		if (text.trim()) out.push(text.trim());
	}
	return out;
}

function docxSections(bytes: Uint8Array): string[] {
	const files = unzipEntries(bytes, (n) => n === 'word/document.xml');
	const xml = files.get('word/document.xml');
	if (xml === undefined) throw new Error('Not a Word document (word/document.xml is missing).');
	const sections: string[] = [];
	let current = '';
	for (const p of ooxmlParagraphs(xml, 'w')) {
		if (current && current.length + p.length > SECTION_CHARS) {
			sections.push(current);
			current = '';
		}
		current = current ? `${current}\n\n${p}` : p;
	}
	if (current) sections.push(current);
	return sections;
}

// A relationship target is relative to the folder of the part that declares it.
function resolvePartPath(fromDir: string, target: string): string {
	if (target.startsWith('/')) return target.slice(1);
	const parts = fromDir.split('/').filter(Boolean);
	for (const seg of target.split('/')) {
		if (seg === '..') parts.pop();
		else if (seg !== '.') parts.push(seg);
	}
	return parts.join('/');
}

function relationships(xml: string | undefined): Map<string, { target: string; type: string }> {
	const out = new Map<string, { target: string; type: string }>();
	for (const m of (xml ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
		const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
		const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
		const type = /\bType="([^"]+)"/.exec(m[0])?.[1] ?? '';
		if (id && target) out.set(id, { target: decodeXmlEntities(target), type });
	}
	return out;
}

const SLIDE_FILE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;

function pptxSlides(bytes: Uint8Array): string[] {
	const files = unzipEntries(
		bytes,
		(n) =>
			n === 'ppt/presentation.xml' ||
			n === 'ppt/_rels/presentation.xml.rels' ||
			/^ppt\/slides\/(_rels\/)?slide\d+\.xml(\.rels)?$/.test(n) ||
			/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)
	);
	const presentation = files.get('ppt/presentation.xml');
	if (presentation === undefined) {
		throw new Error('Not a PowerPoint deck (ppt/presentation.xml is missing).');
	}

	// Slide order is the presentation's `sldIdLst`, not the file numbering: a slide
	// moved in PowerPoint keeps its file name. Hidden slides are still listed.
	const rels = relationships(files.get('ppt/_rels/presentation.xml.rels'));
	const ordered: string[] = [];
	for (const m of presentation.matchAll(/<p:sldId\b[^>]*>/g)) {
		const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
		const rel = rid ? rels.get(rid) : undefined;
		if (rel) ordered.push(resolvePartPath('ppt', rel.target));
	}
	// Without a usable list, fall back to file numbering.
	const slidePaths = ordered.length
		? ordered.filter((p) => files.has(p))
		: [...files.keys()]
				.filter((n) => SLIDE_FILE_RE.test(n))
				.sort((a, b) => Number(SLIDE_FILE_RE.exec(a)![1]) - Number(SLIDE_FILE_RE.exec(b)![1]));

	return slidePaths.map((slidePath) => {
		const body = ooxmlParagraphs(files.get(slidePath) ?? '', 'a').join('\n');
		const dir = slidePath.slice(0, slidePath.lastIndexOf('/'));
		const name = slidePath.slice(slidePath.lastIndexOf('/') + 1);
		const slideRels = relationships(files.get(`${dir}/_rels/${name}.rels`));
		const notesRel = [...slideRels.values()].find((r) => r.type.endsWith('/notesSlide'));
		const notesXml = notesRel ? files.get(resolvePartPath(dir, notesRel.target)) : undefined;
		// A notes page also carries the slide image placeholder and the slide number;
		// only the body placeholder holds what the presenter wrote.
		const notes = notesXml ? notesBody(notesXml) : '';
		return notes ? `${body}\n\nSpeaker notes:\n${notes}`.trim() : body;
	});
}

function notesBody(xml: string): string {
	const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? [];
	const bodies = shapes.filter((s) => /<p:ph\b[^>]*type="body"/.test(s));
	return bodies.flatMap((s) => ooxmlParagraphs(s, 'a')).join('\n');
}

// ---------- choosing which parts to return ----------

// `pages` as a caller writes it: "3", "2-5", "10-". 1-based, inclusive. Returns the
// zero-based half-open range, or a reason the spec is unusable.
export function parsePartRange(
	spec: string | undefined,
	total: number
): { start: number; end: number } | { error: string } {
	if (!spec?.trim()) return { start: 0, end: total };
	const m = /^\s*(\d+)\s*(?:(-)\s*(\d*)\s*)?$/.exec(spec);
	if (!m)
		return { error: `"${spec}" is not a range. Use a number ("3") or a range ("2-5", "10-").` };
	const from = Number(m[1]);
	const to = m[2] ? (m[3] ? Number(m[3]) : total) : from;
	if (from < 1 || to < from) return { error: `"${spec}" is not a valid range.` };
	if (from > total) return { error: `It starts past the end: there are ${total}.` };
	return { start: from - 1, end: Math.min(to, total) };
}

// Characters of document text one read_media reply carries before it stops and says
// where to continue. Roughly 10k tokens: enough for a contract's key pages, small
// enough that a host's tool-result limit is never the thing that truncates it.
export const DOCUMENT_TEXT_BUDGET = 40_000;

export interface DocumentSlice {
	unit: DocumentUnit;
	total: number;
	// 1-based, inclusive. `last < first` when nothing in range had any text.
	first: number;
	last: number;
	text: string;
	// The `pages` argument that continues the read, when the reply stopped early.
	next?: string;
}

// The parts in range, each headed with its number, up to the budget. Always returns
// at least one part, cut if it alone exceeds the budget, so a caller paging forward
// can never be stuck on a part too large to fit.
export function sliceDocument(
	doc: DocumentText,
	range: { start: number; end: number },
	budget = DOCUMENT_TEXT_BUDGET
): DocumentSlice {
	const label = doc.unit[0].toUpperCase() + doc.unit.slice(1);
	const chunks: string[] = [];
	let used = 0;
	let i = range.start;
	for (; i < range.end; i++) {
		const body = doc.parts[i] || '(no text)';
		const chunk = `--- ${label} ${i + 1} ---\n${body}`;
		if (chunks.length && used + chunk.length > budget) break;
		chunks.push(
			chunk.length > budget ? `${chunk.slice(0, budget)}\n[cut: over the length limit]` : chunk
		);
		used += chunk.length;
	}
	return {
		unit: doc.unit,
		total: doc.parts.length,
		first: range.start + 1,
		last: i,
		text: chunks.join('\n\n'),
		...(i < range.end
			? { next: `${i + 1}-${range.end === doc.parts.length ? '' : range.end}` }
			: {})
	};
}
