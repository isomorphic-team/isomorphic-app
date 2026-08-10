// Attachments inside the editor: paste, drop, and rendering.
//
// This is the whole upload surface for the product now. The page viewer has none by
// design — the viewer is not where content changes — and the model cannot supply
// bytes, so an image enters a brain here or nowhere.
//
// Modelled on Obsidian, which has no drop widget at all: you drag onto the editor or
// you paste, and the file lands in an attachment folder beside the note. The one place
// we deliberately differ is the link it writes. Obsidian embeds `![[file.png]]`, which
// survives a move for free but is unreadable outside Obsidian; we write an ordinary
// relative `![](assets/file.png)` so the page still renders on github.com and in any
// OKF reader, and repoint on move instead.
//
// The mechanic Obsidian does NOT have to solve: it writes to a local vault, so its
// insert is instantaneous. Ours is a network round trip through attach_media, which
// means a save can race an upload. Hence `pendingUploads` below.

import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { defaultAttachmentPath, mediaTypeOf } from '../../src/lib/media.ts';
import { relativeHref, resolveRelative } from '../../src/lib/wiki.ts';
import { loadAsset, prepareUpload, uploadAttachment } from './media.ts';
import { toast } from './toast.tsx';
import { bump } from './store.ts';

// How many uploads are in flight. The editor's Save is disabled while this is above
// zero: the image node is inserted immediately (so you see where it went and can keep
// typing), but its bytes are still travelling, and saving first would commit a page
// that links to a file the brain does not have yet.
let pendingUploads = 0;
export function uploadsInFlight(): boolean {
	return pendingUploads > 0;
}

// Files worth intercepting from a paste or a drop. A paste of ordinary text carries no
// files and must fall through to ProseMirror untouched, or we would break every normal
// copy-paste in the editor.
function attachableFiles(list: FileList | null | undefined): File[] {
	if (!list || list.length === 0) return [];
	return Array.from(list).filter((f) => !!mediaTypeOf(f.name || ''));
}

// A pasted screenshot arrives as a File with no useful name ("image.png", or empty).
// Give it something a human can recognise in a file tree six months later, since this
// name becomes a permanent path in the repo.
// Seconds, not minutes. The stamp is the whole of the uniqueness: two pastes a few
// seconds apart produced the same name, defaultAttachmentPath produced the same path,
// and the second upload overwrote the first with no error anywhere. `index` only
// separates files within ONE paste, so it does not help across two.
function nameFor(file: File, index: number): string {
	const raw = (file.name || '').trim();
	if (raw && raw.toLowerCase() !== 'image.png') return raw;
	const ext = (mediaTypeOf(raw) ? raw.split('.').pop() : 'png') ?? 'png';
	const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
	return `pasted-${stamp}${index ? `-${index + 1}` : ''}.${ext}`;
}

// Insert an image node at `pos` and return a handle that can find it again later.
// Positions shift as the user keeps typing, so the node is located by identity on
// completion rather than by remembering an offset.
function insertImage(view: EditorView, pos: number, src: string, alt: string): PMNode {
	const node = view.state.schema.nodes.image.create({ src, alt });
	view.dispatch(view.state.tr.insert(pos, node));
	return node;
}

function findNodePos(view: EditorView, node: PMNode): number | null {
	let found: number | null = null;
	view.state.doc.descendants((n, p) => {
		if (found !== null) return false;
		if (n === node) {
			found = p;
			return false;
		}
		return true;
	});
	return found;
}

function removeNode(view: EditorView, node: PMNode): void {
	const pos = findNodePos(view, node);
	if (pos === null) return;
	view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
}

// Point an already-inserted image at a different path. Needed because the node goes in
// before the upload finishes, and the server may store the file under another name if
// that one was taken. Returns the replacement node, since changing attrs makes a new
// one and the old handle no longer matches anything in the document.
function repointImage(view: EditorView, node: PMNode, src: string): PMNode | null {
	const pos = findNodePos(view, node);
	if (pos === null) return null;
	const replacement = view.state.schema.nodes.image.create({ ...node.attrs, src });
	view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, replacement));
	return replacement;
}

// Upload one file and leave an image node pointing at it.
//
// The node is inserted BEFORE the upload finishes, with the path the file is going to
// land at. That path is deterministic (defaultAttachmentPath), so the markdown is
// correct from the first frame and never has to be rewritten — the only thing still
// outstanding is the bytes, which is exactly what the save guard covers.
async function uploadOne(
	view: EditorView,
	pagePath: string,
	file: File,
	pos: number,
	index: number
): Promise<void> {
	const filename = nameFor(file, index);
	const prepared = await prepareUpload(new File([file], filename, { type: file.type }));
	if ('error' in prepared) {
		toast(prepared.error, true);
		return;
	}

	const target = defaultAttachmentPath(pagePath, prepared.filename);
	const href = relativeHref(pagePath, target);
	const alt = prepared.filename.replace(/\.[a-z0-9]+$/i, '');

	// Prime the preview BEFORE inserting the node, not after. Inserting constructs the
	// nodeView, which looks for a local preview synchronously; priming afterwards meant
	// it never saw one, fell through to read_media for bytes the server had not been
	// sent yet, and latched into "Missing attachment" for the rest of the session. The
	// upload then succeeded silently behind a picture that said it had failed.
	primeLocalPreview(target, `data:${prepared.mimeType};base64,${prepared.data}`);
	const node = insertImage(view, pos, href, alt);

	pendingUploads++;
	bump();
	try {
		const res = await uploadAttachment(target, prepared);
		if (!res.ok) {
			toast(res.message || `Could not add ${prepared.filename}.`, true);
			removeNode(view, node);
			forgetLocalPreview(target);
			return;
		}
		// The server renames on a collision, since only it can see what the repo already
		// holds. Follow it, or the page keeps a link to a name nothing occupies.
		if (res.storedAt !== target) {
			primeLocalPreview(res.storedAt, `data:${prepared.mimeType};base64,${prepared.data}`);
			forgetLocalPreview(target);
			repointImage(view, node, relativeHref(pagePath, res.storedAt));
		}
		if (prepared.note) toast(prepared.note);
	} catch (e) {
		toast(`Could not add ${prepared.filename}: ${e}`, true);
		removeNode(view, node);
		forgetLocalPreview(target);
	} finally {
		pendingUploads--;
		bump();
	}
}

// Local previews for images whose bytes have not been committed yet (or have just
// been, but the read path has not seen them). Keyed by repo path so the nodeView can
// find one without knowing whether it came from an upload or the server.
const localPreviews = new Map<string, string>();

// The nodeViews currently on screen, by the path each one is showing. A nodeView
// resolves ONCE, when it is constructed, so without this it can only ever be as
// correct as the instant it was built — and an image whose bytes arrive a moment
// later stays broken until you leave the page and come back. Registering them means
// the bytes can find the picture instead of the picture having to poll for bytes.
const liveViews = new Map<string, Set<ImageNodeView>>();

function registerView(path: string, view: ImageNodeView): void {
	let set = liveViews.get(path);
	if (!set) liveViews.set(path, (set = new Set()));
	set.add(view);
}
function unregisterView(path: string, view: ImageNodeView): void {
	const set = liveViews.get(path);
	if (!set) return;
	set.delete(view);
	if (set.size === 0) liveViews.delete(path);
}

function primeLocalPreview(path: string, dataUri: string): void {
	localPreviews.set(path, dataUri);
	for (const v of liveViews.get(path) ?? []) v.showBytes(dataUri);
}
function forgetLocalPreview(path: string): void {
	localPreviews.delete(path);
}

// Paste and drop handlers, wired into EditorView's props.
export function mediaHandlers(pagePath: string) {
	return {
		handlePaste(view: EditorView, event: ClipboardEvent): boolean {
			const files = attachableFiles(event.clipboardData?.files);
			if (files.length === 0) return false; // ordinary paste: leave it alone
			event.preventDefault();
			const at = view.state.selection.from;
			files.forEach((f, i) => void uploadOne(view, pagePath, f, at, i));
			return true;
		},
		handleDrop(view: EditorView, event: DragEvent): boolean {
			const files = attachableFiles(event.dataTransfer?.files);
			if (files.length === 0) return false;
			event.preventDefault();
			// Drop position, not the cursor: the whole point of a drop is that you chose
			// where it goes.
			const at =
				view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
				view.state.selection.from;
			files.forEach((f, i) => void uploadOne(view, pagePath, f, at, i));
			return true;
		}
	};
}

// A nodeView for images, so an attachment actually appears while editing.
//
// Needed because the editor gets its content as markdown with RELATIVE hrefs, and the
// iframe cannot load a relative URL — there is no origin serving the brain. Every
// image in the editor would otherwise be a broken-image glyph, including ones that
// render perfectly in the viewer. Same data-URI route the viewer uses, same cache.
export class ImageNodeView {
	// A container, not the <img> itself, so the missing state can REPLACE the image
	// rather than restyle it. An <img> whose src never resolves keeps drawing the
	// browser's own broken-image glyph beside whatever alt text you set, and no CSS
	// removes that glyph — so a note meant to read as prose still reads as a broken
	// picture. The viewer learned this already (hydrateImages swaps in a span); the
	// nodeView was still setting alt on a live <img> and showing the glyph.
	dom: HTMLSpanElement;
	private alt: string;
	private repoPath = '';

	constructor(node: PMNode, pagePath: string) {
		this.alt = String(node.attrs.alt ?? '');
		this.dom = document.createElement('span');
		this.dom.className = 'asset-node';
		void this.resolve(String(node.attrs.src ?? ''), pagePath);
	}

	private async resolve(src: string, pagePath: string): Promise<void> {
		if (!src || /^(data:|https?:|blob:)/i.test(src)) {
			this.showBytes(src);
			return;
		}
		this.repoPath = resolveRelative(pagePath, src);
		registerView(this.repoPath, this);

		const local = localPreviews.get(this.repoPath);
		if (local) {
			this.showBytes(local);
			return;
		}
		const dataUri = await loadAsset(this.repoPath);
		// An upload that finished while this was in flight has already called
		// showBytes through the registry; don't overwrite a good picture with a
		// stale miss.
		if (dataUri) this.showBytes(dataUri);
		else if (!this.resolved) this.showMissing();
	}

	private resolved = false;

	// Called both by resolve() and, when an upload completes, by primeLocalPreview.
	showBytes(src: string): void {
		this.resolved = true;
		const img = document.createElement('img');
		img.src = src;
		img.alt = this.alt;
		img.className = 'max-w-full rounded';
		this.dom.replaceChildren(img);
	}

	private showMissing(): void {
		const note = document.createElement('span');
		note.className = 'asset-missing';
		note.textContent = `Missing attachment: ${this.repoPath}`;
		note.title = `${this.repoPath} is linked from this page but is not in the brain. It may have been moved or deleted.`;
		this.dom.replaceChildren(note);
	}

	destroy(): void {
		if (this.repoPath) unregisterView(this.repoPath, this);
	}

	// Attachments are atomic: there is nothing inside an image for ProseMirror to
	// manage, and saying so keeps the editor from trying to place a cursor in it.
	stopEvent(): boolean {
		return false;
	}
	ignoreMutation(): boolean {
		return true;
	}
}
