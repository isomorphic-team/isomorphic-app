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

// Lines that name something real. One of these opens the rotation, and every other
// line after that is one, alternating with the library lines below.
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

// The name-free half of every rotation, interleaved with the specific lines above
// rather than waiting behind them (see loadingLines). Librarian rather than machine:
// this product's job is a wiki someone else has to keep, and "compiling" would be a
// lie about what is happening.
//
// The joke has to land on somebody who has only ever been a library PATRON, so the
// vocabulary stops at what a person meets from the public side of the desk. The
// archival trade words that were here first (finding aids, cotton gloves, folder
// ribbons, microfiche) named real things and read as showing off.
//
// Long on purpose. A rotation shows two or three of these, and somebody who waits
// several times in one session should not meet the same joke twice.
const POOL: string[] = [
	// The desk. Most of what a librarian actually does is answer the same questions.
	'Consulting the librarian…',
	'Asking at the reference desk…',
	'The librarian is looking it up…',
	'Asking whether you tried the catalogue…',
	'Whispering the answer…',
	'Keeping our voice down…',
	'Shushing somebody…',
	// The patron. Every one of these is a thing that happens to a library daily.
	'It had a blue cover, apparently…',
	'Somebody shelved it wrong…',
	'Somebody else has it out…',
	'Quietly waiving your late fee…',
	'Checking how overdue this is…',
	'It came back in the book drop…',
	'Unjamming the printer…',
	'Sharpening a very small pencil…',
	'The returns cart is never empty…',
	// The stacks.
	'Following a wikilink into the stacks…',
	'Retrieving it from the stacks…',
	'Second shelf from the top…',
	'Following the spine labels…',
	'Somewhere in the 300s…',
	'Shelving a stray thought…',
	'Reshelving as we go…',
	// The catalogue.
	'Checking the index cards…',
	'Consulting the card catalogue…',
	'Filed under something sensible…',
	'Looking for the misfiled one…',
	'Cross-referencing…',
	'Untangling the backlinks…',
	// The book itself.
	'Chasing a footnote…',
	'Reading the margins…',
	'Reading somebody else’s underlining…',
	'Unfolding the map at the back…',
	'Finding where the bookmark went…',
	'Blowing the dust off the spine…',
	'Stamping the due date…',
	'Squinting at the handwriting…',
	'Dusting off the archive…',
	'Turning the page…'
];

// A few tasks want library lines of their own, because the general ones would be
// about the wrong thing entirely. Mixed into the same queue as POOL.
const POOL_BY_TASK: Partial<Record<LoadingTask, string[]>> = {
	graph: ['Pulling the threads apart…', 'Letting the nodes settle…', 'Untangling the backlinks…'],
	create: [
		'Deciding where it lives…',
		'Choosing a good name…',
		'Clearing a shelf for it…',
		'Making room…'
	],
	// A circulation desk is what this tab is: who borrowed what, how often.
	analytics: ['Checking the circulation records…', 'Carrying the one…', 'Squaring the columns…'],
	activity: ['Reading the due-date card…', 'Checking the date stamps…', 'Who had this out…'],
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
 * The phrases that FOLLOW the caller's own label.
 *
 * ALTERNATING: one line about this brain, then one about the library, then back.
 * The library lines are not a fallback the rotation reaches only after the specific
 * ones run out — that ordering spent the whole of a normal wait on facts and put the
 * humor somewhere almost nobody got to. Interleaving means a rotation reads as one
 * voice that happens to know your brain's name, rather than a personalized part
 * followed by a generic part.
 *
 * It still OPENS specific, because the second thing read (the label is first) should
 * be about the thing being waited on. With no facts at all, the specific queue is
 * empty and the whole rotation comes from the library, which is the cold-open case.
 *
 * Never empty, never contains the label itself, never contains an unfilled slot.
 */
export function loadingLines(task: LoadingTask, facts: LoadingFacts = {}, seed = 0): string[] {
	const values = slotValues(facts);
	const next = rng(hashSeed(`${task}|${facts.subject ?? ''}|${facts.brain ?? ''}`) ^ (seed | 0));

	const specific = shuffled(WARM[task] ?? WARM.generic, next)
		.map((t) => render(t, values))
		.filter((l): l is string => l !== null);
	const library = shuffled([...(POOL_BY_TASK[task] ?? []), ...POOL], next);

	const out: string[] = [];
	const queues = [specific, library];
	let turn = 0;
	while (out.length < MAX_LINES && (queues[0].length || queues[1].length)) {
		// Take from the other queue when this one is spent, so a task with two specific
		// lines still fills a rotation instead of stopping at two.
		const line = (queues[turn].length ? queues[turn] : queues[1 - turn]).shift();
		if (line && !out.includes(line)) out.push(line);
		turn = 1 - turn;
	}
	return out;
}

export { MAX_LINES, hashSeed, possessive, clip, groupDigits, WARM, POOL, POOL_BY_TASK };
