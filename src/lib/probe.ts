// Probe: does the page that OWNS a question actually come back when the question is
// asked? The consolidation detector (consolidate.ts) reasons about the brain as a
// data structure; this reasons about it as an answering machine, which is the thing
// the structural checks are all proxies for.
//
// Pure over the hits a search returns, so the rule is testable without D1. The caller
// runs the search; this scores it.
//
// WHAT THIS CAN AND CANNOT MEASURE ON TODAY'S ENGINE. searchIndex is a literal
// substring LIKE over the whole query, returning rows ORDER BY path, capped at a hit
// budget. Three consequences shape everything below:
//
//   1. There is NO relevance ranking. Position in the result set is alphabetical by
//      path. `position` is reported for exactly one reason — the hit cap truncates in
//      path order, so position decides who survives — and it is never a quality score.
//   2. A multi-word natural-language question matches only if that exact string
//      appears in a line. Probes have to be phrase-shaped, and a question that finds
//      nothing is a fact about the QUERY, not necessarily about the brain.
//   3. When the hit budget is reached, absence is not evidence of absence. A probe
//      that truncated is reported as inconclusive rather than failed.
export interface ProbeHit {
	path: string;
	line: number;
	text: string;
}

// A probe the expected page loses splits in two, and the distinction is the whole
// value of the instrument. ABSENT means no page in the brain answered: a content gap,
// which no structural check can ever find. ELSEWHERE means the question IS answered,
// by a page that does not own it — the competition case that lexical similarity
// cannot see. Collapsing the two into one "missing" verdict throws the second away.
export type ProbeVerdict = 'owned' | 'contested' | 'elsewhere' | 'absent' | 'inconclusive';

export interface ProbeResult {
	query: string;
	expect: string;
	verdict: ProbeVerdict;
	// Distinct pages that matched, in the order the engine returned them (path order).
	matched: string[];
	// 1-based position of `expect` among `matched`, or null when it did not match.
	position: number | null;
	// Matching lines on the expected page.
	linesOnExpected: number;
	// Other pages answering to the same query.
	competitors: string[];
	// The hit budget was exhausted, so pages later in path order may be unrepresented.
	truncated: boolean;
}

// More than this many other pages matching a probe means the query is a general term
// rather than one page's question: the model asking it gets a pile, not an answer.
const CONTESTED_AT = 3;

export function scoreProbe(
	query: string,
	expect: string,
	hits: ProbeHit[],
	hitBudget: number
): ProbeResult {
	const truncated = hits.length >= hitBudget;
	const matched: string[] = [];
	for (const h of hits) if (!matched.includes(h.path)) matched.push(h.path);
	const idx = matched.indexOf(expect);
	const competitors = matched.filter((p) => p !== expect);
	const linesOnExpected = hits.filter((h) => h.path === expect).length;

	let verdict: ProbeVerdict;
	if (idx === -1) {
		if (truncated) verdict = 'inconclusive';
		else verdict = matched.length ? 'elsewhere' : 'absent';
	} else if (competitors.length > CONTESTED_AT) verdict = 'contested';
	else verdict = 'owned';

	return {
		query,
		expect,
		verdict,
		matched,
		position: idx === -1 ? null : idx + 1,
		linesOnExpected,
		competitors,
		truncated
	};
}

export interface ProbeSummary {
	total: number;
	owned: number;
	contested: number;
	elsewhere: number;
	absent: number;
	inconclusive: number;
	// Pages that answered to probes they do not own, most frequent first. A page that
	// keeps surfacing for other pages' questions is competing with them, which is the
	// conceptual-duplicate case lexical similarity cannot see.
	intruders: { path: string; count: number }[];
}

export function summarizeProbes(results: ProbeResult[]): ProbeSummary {
	const counts = { owned: 0, contested: 0, elsewhere: 0, absent: 0, inconclusive: 0 };
	const intruder = new Map<string, number>();
	for (const r of results) {
		counts[r.verdict]++;
		for (const c of r.competitors) intruder.set(c, (intruder.get(c) ?? 0) + 1);
	}
	return {
		total: results.length,
		...counts,
		intruders: [...intruder]
			.map(([path, count]) => ({ path, count }))
			.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
	};
}

// The self-fulfilling probe. If a page stores the questions it claims to answer in
// its own frontmatter, that text is indexed like any other content, so the page
// matches its own probe because the probe is printed on it — the number then measures
// whether the question was written down, not whether the page is findable. Callers
// that read probes off a page MUST strip the declaring block from that page's content
// before searching. Kept here, beside the scorer, so the requirement travels with it.
export function stripDeclaredProbes(content: string, key = 'answers'): string {
	const lines = content.split('\n');
	if (lines[0]?.trim() !== '---') return content;
	const end = lines.indexOf('---', 1);
	if (end === -1) return content;
	const out: string[] = [];
	let inKey = false;
	for (let i = 0; i <= end; i++) {
		const line = lines[i];
		const m = line.match(/^([A-Za-z0-9_-]+):/);
		if (m) inKey = m[1] === key;
		else if (inKey && /^\s*-\s/.test(line)) continue;
		if (inKey && m) continue;
		out.push(line);
	}
	return [...out, ...lines.slice(end + 1)].join('\n');
}
