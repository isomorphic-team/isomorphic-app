// How a brain is addressed: `<name>-<handle>`, e.g. `team-wiki-3fa9c2`.
//
// Pure and Worker-safe, and imported by the app. The handle (`brains.handle`, six
// random hex characters) is what identifies the brain; the name part is for people
// and may be stale. So a renamed brain's old URL still resolves, and the name part
// is never trusted to pick one.
//
// Not the primary key (`brain_id`, which keys derived state) and not the storage
// locator (`owner/repo`, which a relocation changes).

const HANDLE = /^[0-9a-f]{6}$/;

// Longest name part kept in a slug, so a long display name does not produce an
// unwieldy URL. Cut at a word boundary where there is one.
const MAX_NAME = 40;

// A new random handle. Unique by the `brains_handle_idx` index; the caller retries
// on the rare collision.
export function newBrainHandle(): string {
	const bytes = new Uint8Array(3);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function slugifyName(label: string): string {
	const s = label
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (s.length <= MAX_NAME) return s;
	const cut = s.slice(0, MAX_NAME);
	const dash = cut.lastIndexOf('-');
	return dash > 0 ? cut.slice(0, dash) : cut;
}

// The slug for a brain. A name that slugifies to nothing (all punctuation, or a
// script with no Latin letters) leaves the handle alone.
export function brainSlug(label: string, handle: string): string {
	const name = slugifyName(label);
	return name ? `${name}-${handle}` : handle;
}

// The handle a slug ends in, or undefined when it does not end in one.
export function handleOfSlug(slug: string): string | undefined {
	const s = slug.trim().toLowerCase();
	const tail = s.slice(s.lastIndexOf('-') + 1);
	return HANDLE.test(tail) ? tail : undefined;
}

// A provisional display name for a slug, before the brain list supplies the real
// one: the name part with dashes as spaces.
export function labelOfSlug(slug: string): string {
	const handle = handleOfSlug(slug);
	const name = handle ? slug.slice(0, Math.max(0, slug.length - handle.length - 1)) : slug;
	return name.replace(/-+/g, ' ').trim() || slug;
}
