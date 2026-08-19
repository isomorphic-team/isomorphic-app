// What a wait SAYS. Pure: templates in, ordered lines out, no DOM and no clock.
//
// The app's loading states were one static string each ("Loading…", "Building the
// graph…"), which reads as stalled the moment it outlives its welcome. This builds the
// rotation that replaces them: a short sequence of phrases the view swaps on an
// interval.
//
// Two rules shape everything here.
//
// THE FIRST LINE IS NOT MINE. The caller's own literal label ("Loading files…") stays
// on screen first, and these lines only ever follow it. A load that finishes in 200ms
// therefore never shows a joke, and nothing whimsical is ever the only thing a user
// sees while they wait for an answer.
//
// A SLOT IS A REQUIREMENT, NOT A DEFAULT. A template naming {brain} is simply not
// eligible when no brain is known, so a line can never render as "Asking …" or, worse,
// "Asking undefined…". That is why the personalization is structural rather than a
// pile of conditionals: the facts a deployment happens to have decide which lines
// exist, and a deployment with none of them still gets a full rotation from the pool
// that names nothing.
//
// Everything here is local. These lines are built from what the widget already holds
// (the brain it is showing, that brain's org, the page or query it was asked for, the
// size of the cached tree). Nothing calls a tool to decorate a wait, and nothing here
// reaches for a person's name or email: identity is fetched by one screen, on request,
// and a colleague's name is not chrome.

export type LoadingTask =
	| 'connect'
	| 'page'
	| 'asset'
	| 'files'
	| 'folder'
	| 'search'
	| 'graph'
	| 'activity'
	| 'members'
	| 'analytics'
	| 'brains'
	| 'sharing'
	| 'switch'
	| 'create'
	| 'settings'
	| 'generic';

// What the widget knows about the wait it is in, all of it optional. `subject` is
// whatever the task is about: a page title, a folder name, a search query, the brain
// being switched to.
export interface LoadingFacts {
	brain?: string;
	org?: string;
	subject?: string;
	pages?: number;
}

// How many lines a rotation runs to before it loops. Six at the view's interval is
// about fifteen seconds, which is longer than any load that is going to succeed.
const MAX_LINES = 6;

// Longer than this and the line stops being a glance.
const MAX_SUBJECT = 36;

const SLOT_RE = /\{(brain|org|orgs|subject|pages)\}/g;

// Lines that name something real. Ordered before the pool below, so the rotation gets
// specific before it gets playful: the second thing you read is about YOUR brain, and
// only a wait that outlasts that earns a joke.
const WARM: Record<LoadingTask, string[]> = {
	connect: ['Finding {brain}…', 'Shaking hands…', 'Opening a line to {brain}…'],
	page: ['Finding {subject}…', 'Turning to {subject}…', 'Fetching {subject} from {brain}…'],
	asset: ['Finding {subject}…', 'Unwrapping {subject}…'],
	files: [
		'Laying out {brain}…',
		'Counting {pages} pages…',
		'Reading the shelves in {brain}…',
		'Mapping {orgs} corner of the world…'
	],
	folder: ['Opening {subject}…', 'Seeing what is in {subject}…'],
	search: [
		'Looking for {subject}…',
		'Reading {pages} pages for {subject}…',
		'Asking {brain} about {subject}…'
	],
	graph: ['Drawing the links in {brain}…', 'Wiring up {pages} pages…', 'Finding the clusters…'],
	activity: ['Rewinding {brain}…', 'Reading the changelog…', 'Working out who touched what…'],
	members: ['Rounding up {org}…', 'Counting heads…', 'Reading the roster…'],
	analytics: ['Tallying up {org}…', 'Doing the arithmetic…', 'Adding up the week…'],
	brains: ['Lining up your brains…', 'Seeing where you can go…'],
	sharing: ['Checking who holds a key to {brain}…', 'Reading the guest list…'],
	switch: ['Walking over to {subject}…', 'Packing up {brain}…', 'Changing brains…'],
	create: ['Naming things is the hard part…', 'Laying the foundation…', 'Clearing a shelf…'],
	settings: ['Finding your things…', 'Checking your keys…'],
	generic: ['Asking {brain}…', 'Reading {pages} pages…']
};

// The tail every task falls back to: brain-shaped, name-free, and safe anywhere.
// Deliberately librarian rather than machine. This product's job is a wiki someone
// else has to keep, and "compiling" would be a lie about what is happening.
// Long on purpose. A rotation shows at most three or four of these, and a person who
// waits several times in a session should not meet the same joke twice.
const POOL: string[] = [
	// The librarian, and the reading room
	'Consulting the librarian…',
	'Asking at the reference desk…',
	'The librarian is looking it up…',
	'Keeping our voice down…',
	'Tiptoeing past the reading room…',
	'Asking around…',
	// The stacks
	'Following a wikilink into the stacks…',
	'Retrieving it from the stacks…',
	'Second shelf from the top…',
	'Following the spine labels…',
	'Somewhere in the periodicals…',
	'Behind the glass, with the rare books…',
	'Shelving a stray thought…',
	'Reshelving as we go…',
	'Checking the returns cart…',
	// The catalogue
	'Checking the index cards…',
	'Consulting the card catalogue…',
	'Filed under something sensible…',
	'Looking for the misfiled one…',
	'Cross-referencing…',
	'Untangling the backlinks…',
	// The archive proper
	'Dusting off the archive…',
	'Waking the archivist…',
	'Pulling the box from storage…',
	'Untying the folder ribbon…',
	'Putting the cotton gloves on…',
	'Rewinding the microfiche…',
	'Consulting the finding aid…',
	// The book itself
	'Chasing a footnote…',
	'Reading the margins…',
	'Reading someone else’s underlining…',
	'Checking the errata…',
	'Turning to the appendix…',
	'Unfolding the map at the back…',
	'Finding where the bookmark went…',
	'Blowing the dust off the spine…',
	'Squinting at the handwriting…',
	'Turning the page…'
];

// A couple of tasks want a tail of their own, because the generic one would be about
// the wrong thing entirely.
const POOL_BY_TASK: Partial<Record<LoadingTask, string[]>> = {
	graph: [
		'Pulling the threads apart…',
		'Letting the nodes settle…',
		'Drawing the concordance…',
		'Untangling the backlinks…'
	],
	create: [
		'Deciding where it lives…',
		'Choosing a good name…',
		'Clearing a shelf for it…',
		'Making room…'
	],
	// A circulation desk is what this tab is: who borrowed what, how often.
	analytics: ['Checking the circulation records…', 'Carrying the one…', 'Squaring the columns…'],
	activity: ['Reading the accession log…', 'Checking the date stamps…'],
	members: ['Counting the library cards…', 'Reading the sign-in book…'],
	sharing: ['Seeing who holds a card…', 'Checking the lending rules…']
};

// Deterministic PRNG. A rotation should look picked, not sorted, and it must still be
// the SAME picked order for a given seed: the golden test pins sequences, and a widget
// that reshuffled on every re-render would swap lines mid-fade.
function rng(seed: number): () => number {
	let s = seed | 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return ((s >>> 0) % 100000) / 100000;
	};
}

function shuffled<T>(items: readonly T[], next: () => number): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

// A stable seed from a string, so the same wait reads the same way twice in a row and
// two different pages do not.
function hashSeed(input: string): number {
	let h = 2166136261;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

// "Acme" -> "Acme's", "Acme Labs" -> "Acme Labs'". Worth the eight lines: the
// possessive is what makes {orgs} read as someone's actual company rather than a
// field that got substituted.
function possessive(name: string): string {
	return /s$/i.test(name) ? `${name}’` : `${name}’s`;
}

function clip(text: string, max = MAX_SUBJECT): string {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// Thousands separators without toLocaleString, whose grouping and separator follow the
// runtime's locale: a golden test would then pass here and fail on a contributor's
// machine, and the bundle would read "1 234" for some users with no way to see why.
function groupDigits(n: number): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// The values a template can name, absent when the widget does not know them. Absent is
// the important half: it is what makes a template ineligible rather than blank.
function slotValues(facts: LoadingFacts): Record<string, string | undefined> {
	const brain = facts.brain?.trim();
	const org = facts.org?.trim();
	const subject = facts.subject?.trim();
	const pages = typeof facts.pages === 'number' && facts.pages > 0 ? facts.pages : undefined;
	return {
		brain: brain ? clip(brain) : undefined,
		org: org ? clip(org) : undefined,
		orgs: org ? possessive(clip(org)) : undefined,
		subject: subject ? clip(subject) : undefined,
		pages: pages ? groupDigits(pages) : undefined
	};
}

// A template survives only if every slot it names has a value.
function render(template: string, values: Record<string, string | undefined>): string | null {
	let missing = false;
	const out = template.replace(SLOT_RE, (_m, key: string) => {
		const v = values[key];
		if (v === undefined) missing = true;
		return v ?? '';
	});
	return missing ? null : out;
}

/**
 * The phrases that FOLLOW the caller's own label, warmest first.
 *
 * Never empty (the pool names nothing and is always eligible), never contains the
 * label itself, and never contains a line with an unfilled slot.
 */
export function loadingLines(task: LoadingTask, facts: LoadingFacts = {}, seed = 0): string[] {
	const values = slotValues(facts);
	const next = rng(hashSeed(`${task}|${facts.subject ?? ''}|${facts.brain ?? ''}`) ^ (seed | 0));

	const warm = shuffled(WARM[task] ?? WARM.generic, next)
		.map((t) => render(t, values))
		.filter((l): l is string => l !== null);
	const tail = shuffled([...(POOL_BY_TASK[task] ?? []), ...POOL], next);

	const out: string[] = [];
	for (const line of [...warm, ...tail]) {
		if (out.length >= MAX_LINES) break;
		if (!out.includes(line)) out.push(line);
	}
	return out;
}

export { MAX_LINES, hashSeed, possessive, clip, groupDigits, WARM, POOL, POOL_BY_TASK };
