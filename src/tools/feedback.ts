// `submit_feedback`: the user's (and Claude's) route from "this is broken" or
// "it should do X" to an issue on the project's own tracker, without leaving the
// conversation and without needing a GitHub account.
//
// Why this does NOT use the platform GitHub App. The App's declared permissions
// (src/manifest.ts) are `administration` / `contents` / `pull_requests` /
// `metadata`, with no `issues`, deliberately. Adding `issues: write` there would widen
// the scope of EVERY customer org's installation to buy those customers nothing,
// and a self-hoster's App has no access to this project's repo regardless. So
// filing runs on a separate, narrowly scoped credential supplied as FEEDBACK_TOKEN:
// a fine-grained PAT (or a second small App) with Issues: write on one repo.
//
// Config, not identity (docs/design/open-source-boundary.md): the destination is
// FEEDBACK_REPO. Nothing here hardcodes this project's repo, and with the env
// unset the tool is simply NOT REGISTERED, so a fork or a self-hosted instance
// neither files issues into somebody else's tracker nor advertises a tool that
// cannot work. Point it at your own fork and it files there instead.
//
// Two things the handler enforces that are easy to lose in a refactor:
//
//   1. A CONFIRM GATE. The destination repo is public. The first call always
//      returns the exact title and body for the user to read and never posts;
//      only `confirm: true` posts. This is the real privacy backstop; the
//      redaction in src/lib/feedback.ts is a narrow safety net behind it.
//   2. NOTHING IDENTIFYING IS PUBLISHED. Who filed it, from which org and brain,
//      goes to the private `feedback_reports` D1 row (migration 0005); the public
//      issue carries only an opaque report id. See src/lib/feedback.ts for the
//      full reasoning.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
	FEEDBACK_KINDS,
	composeIssue,
	newReportId,
	previewText,
	type FeedbackKind
} from '../lib/feedback.ts';

// Best-effort identity. Every field is optional on purpose: feedback must work on
// the static single-bearer path (no user at all) and for someone who has an org but
// no brain yet. A user who cannot create a brain is exactly the user with
// something to report, so this must never depend on brain resolution succeeding.
export interface FeedbackIdentity {
	userId?: string;
	email?: string;
	ghLogin?: string;
	orgId?: string;
	brainId?: string;
}

interface FeedbackEnv {
	PLATFORM_DB: D1Database;
	// "owner/repo" of the tracker that receives reports. Unset = feature off.
	FEEDBACK_REPO?: string;
	// A token with Issues: write on FEEDBACK_REPO and nothing else.
	FEEDBACK_TOKEN?: string;
}

// A rolling-window cap, so one connection cannot turn a public tracker into a
// firehose. High enough that nobody reporting real problems will notice it.
const MAX_REPORTS_PER_DAY = 10;

function fail(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

function ok(text: string, structuredContent?: Record<string, unknown>) {
	return {
		content: [{ type: 'text' as const, text }],
		...(structuredContent ? { structuredContent } : {})
	};
}

// GitHub returns 422 for a label the token may not create. The report matters more
// than its labels, so a label rejection retries bare rather than losing the issue.
async function createIssue(
	repo: string,
	token: string,
	issue: { title: string; body: string; labels: string[] }
): Promise<{ number: number; html_url: string }> {
	const post = async (body: Record<string, unknown>) =>
		fetch(`https://api.github.com/repos/${repo}/issues`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'Content-Type': 'application/json',
				'User-Agent': 'isomorphic-feedback'
			},
			body: JSON.stringify(body)
		});

	let res = await post(issue);
	if (res.status === 422) {
		res = await post({ title: issue.title, body: issue.body });
	}
	if (!res.ok) {
		throw new Error(`GitHub returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
	}
	return (await res.json()) as { number: number; html_url: string };
}

// Possible duplicates, shown in the preview so the user can pile onto an existing
// thread instead of opening the fourth copy of it. Fail-open: the Search API has
// its own tight rate limit, and losing dedup hints must never lose the report.
async function findSimilar(repo: string, token: string, summary: string): Promise<string[]> {
	const terms = summary
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((w) => w.length > 3)
		.slice(0, 6);
	if (!terms.length) return [];
	const q = `repo:${repo} is:issue is:open ${terms.join(' ')}`;
	try {
		const res = await fetch(
			`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=3`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
					'User-Agent': 'isomorphic-feedback'
				}
			}
		);
		if (!res.ok) return [];
		const data = (await res.json()) as {
			items?: Array<{ number: number; title: string; html_url: string }>;
		};
		return (data.items ?? []).map((i) => `#${i.number} ${i.title} (${i.html_url})`);
	} catch {
		return [];
	}
}

export function registerFeedbackTools(
	server: McpServer,
	getIdentity: () => FeedbackIdentity,
	env: FeedbackEnv
) {
	// Unset destination = the feature is off for this deployment. Registering a tool
	// that can only ever apologize is worse than not offering it.
	if (!env.FEEDBACK_REPO) return;
	const repo = env.FEEDBACK_REPO.trim();

	server.registerTool(
		'submit_feedback',
		{
			title: 'Send feedback to the Isomorphic maintainers',
			// Stands alone and names itself, because a host tool-search for "submit_feedback"
			// or "report a bug" has to land here. See the read_page/view_page note in
			// CLAUDE.md for what happens when a description only describes its sibling.
			description:
				"submit_feedback sends the user's feedback about Isomorphic itself (a bug, a rough edge, a feature idea) to the maintainers as an issue on the project's public issue tracker. Use it whenever the user reports that something in the brain, the viewer/editor, or these tools is broken, confusing, or missing, and whenever they say to tell the maintainers, file a bug, send feedback, or request a feature. The user needs no GitHub account. The issue is PUBLIC and nothing about their account, email, organization, or brain is attached to it. Calling this WITHOUT `confirm` posts nothing: it returns the exact title and body, which you must show the user before calling again with `confirm: true`. This is for feedback about the Isomorphic product, not for writing notes into the user's own brain, which is write_page.",
			inputSchema: {
				kind: z
					.enum(FEEDBACK_KINDS as unknown as [FeedbackKind, ...FeedbackKind[]])
					.describe(
						'"bug" for something behaving wrong, "idea" for a feature request or improvement, "other" for anything else.'
					),
				summary: z
					.string()
					.min(3)
					.describe(
						'One line, specific enough to be the issue title. "Editor drops the last line of a page on save", not "editor bug".'
					),
				details: z
					.string()
					.optional()
					.describe(
						'The full report, in markdown: what the user did, what happened, what they expected. Include the tool or screen involved. Do not include tokens, keys, or anything they would not want published.'
					),
				confirm: z
					.boolean()
					.optional()
					.describe(
						'Omit on the first call to get the exact issue text back without posting. Pass true only after the user has seen that text and agreed to publish it.'
					)
			}
		},
		async ({ kind, summary, details, confirm }) => {
			if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
				return fail(
					`Feedback is misconfigured on this server: FEEDBACK_REPO must be "owner/repo", got "${repo}".`
				);
			}
			const token = env.FEEDBACK_TOKEN;
			if (!token) {
				return fail(
					`Feedback is not fully configured on this server (FEEDBACK_REPO is set to ${repo} but FEEDBACK_TOKEN is missing). Report this to the person who deployed it, or open an issue at https://github.com/${repo}/issues directly.`
				);
			}

			const reportId = newReportId();
			const issue = composeIssue({ kind, summary, details }, reportId);

			if (!confirm) {
				const similar = await findSimilar(repo, token, issue.title);
				const dupes = similar.length
					? `\nOpen issues that might already cover this. Offer these before filing a new one:\n${similar.map((s) => `- ${s}`).join('\n')}\n`
					: '';
				return ok(previewText(issue, repo) + dupes, {
					feedback: { status: 'preview', repo, title: issue.title, labels: issue.labels }
				});
			}

			const identity = getIdentity();
			const reporterKey = identity.userId ?? identity.ghLogin ?? 'anon';
			const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

			// The cap is advisory rather than load-bearing: a D1 hiccup should not
			// swallow a legitimate report, so a failed count lets the call through.
			try {
				const row = await env.PLATFORM_DB.prepare(
					'SELECT COUNT(*) AS n FROM feedback_reports WHERE reporter_key = ? AND created_at > ?'
				)
					.bind(reporterKey, since)
					.first<{ n: number }>();
				if ((row?.n ?? 0) >= MAX_REPORTS_PER_DAY) {
					return fail(
						`That is ${MAX_REPORTS_PER_DAY} reports in the last 24 hours, which is this server's limit. Add to one of the existing issues at https://github.com/${repo}/issues instead, or try again tomorrow.`
					);
				}
			} catch {
				// fall through
			}

			let created: { number: number; html_url: string };
			try {
				created = await createIssue(repo, token, issue);
			} catch (e) {
				return fail(
					`The report could not be filed: ${e instanceof Error ? e.message : String(e)}\n\n` +
						`Nothing was published. The user can open it by hand at https://github.com/${repo}/issues/new.`
				);
			}

			// The private half. Written after the issue exists so a stored row always
			// points at a real issue; a failure here loses the identity mapping, not
			// the report, so it must not turn a filed issue into an error.
			try {
				await env.PLATFORM_DB.prepare(
					`INSERT INTO feedback_reports
					   (report_id, created_at, kind, summary, issue_number, issue_url,
					    reporter_key, user_id, email, gh_login, org_id, brain_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
					.bind(
						reportId,
						new Date().toISOString(),
						kind,
						issue.title,
						created.number,
						created.html_url,
						reporterKey,
						identity.userId ?? null,
						identity.email ?? null,
						identity.ghLogin ?? null,
						identity.orgId ?? null,
						identity.brainId ?? null
					)
					.run();
			} catch {
				// The issue is filed; losing the private mapping only costs follow-up.
			}

			return ok(
				`Filed as issue #${created.number}: ${created.html_url}\n\n` +
					`Report id ${reportId}. Tell the user it is in, and that they can follow or comment on that link; they do not need a GitHub account to read it.`,
				{
					feedback: {
						status: 'filed',
						repo,
						reportId,
						issueNumber: created.number,
						issueUrl: created.html_url
					}
				}
			);
		}
	);
}
