// pnpm onboard-org — stand up a Model-B (customer-owned) org on the LIVE platform.
//
// This is the scripted replacement for hand-editing `src/db/seed-customer-org.sql`.
// A Model-B org points at the CUSTOMER's own GitHub App installation (not the
// platform installation) and adopts an existing repo as its first brain. Three
// D1 rows make that real:
//
//   1. orgs         — the customer org (model='customer', their installation_id,
//                     brain_owner = their GitHub org).
//   2. brains       — adopt their existing KB repo (optional; skip with no --repo
//                     and let them run connect_brain later). Writing it here keeps
//                     the invited owner from landing in a brainless org on first
//                     sign-in.
//   3. invitations  — pre-invite the owner by email so their first magic-link
//                     sign-in joins THIS org (provisionOrgForUser consumes it),
//                     instead of auto-provisioning a personal Model-A brain.
//
// What the script does that raw SQL can't:
//   - Resolves the customer's installation_id from GitHub automatically (App JWT →
//     GET /orgs/{org}/installation). No copy-pasting numbers off GitHub.
//   - Verifies the installation can actually reach --repo before writing a dead
//     brains row (the exact footgun connect_brain guards at runtime).
//   - Bakes the OPERATOR email into created_by/invited_by from config, so you
//     can't accidentally set them to the customer (the seed template's trap).
//   - Applies to local + remote D1 in one run.
//
// Usage:
//   pnpm onboard-org --github-org acme-co --owner-email admin@acme.com \
//     --repo handbook [--org-name "Acme"] [--role owner|admin] \
//     [--operator-email you@example.com] [--apply local|remote|both]
//
// Default is a DRY RUN: it resolves + verifies against GitHub, prints the SQL,
// and writes it to ops/seeds-real/ (gitignored). Nothing touches D1 until you
// pass --apply. Idempotent (INSERT OR IGNORE), so re-running is safe.

import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appOctokit, installationOctokit, type AppCreds } from '../src/lib/github.ts';
import { loadDevVarsIntoEnv } from '../src/persist.ts';

// ---------- arg parsing ----------

interface Args {
	githubOrg: string;
	ownerEmail: string;
	repo?: string;
	orgName?: string;
	orgId?: string;
	brainId?: string;
	role: string;
	operatorEmail?: string;
	apply: 'local' | 'remote' | 'both' | 'none';
	out?: string;
}

function parseArgs(argv: string[]): Args {
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) {
			flags[key] = 'true'; // bare flag
		} else {
			flags[key] = next;
			i++;
		}
	}

	const githubOrg = flags['github-org'];
	const ownerEmail = flags['owner-email'];
	if (!githubOrg || !ownerEmail) {
		fail(
			'Required: --github-org <login> and --owner-email <email>.\n' +
				'Example: pnpm onboard-org --github-org acme-co --owner-email admin@acme.com --repo handbook'
		);
	}

	const applyRaw = flags['apply'] ?? 'none';
	if (!['local', 'remote', 'both', 'none'].includes(applyRaw)) {
		fail(`--apply must be one of local | remote | both (got "${applyRaw}").`);
	}
	const role = flags['role'] ?? 'owner';
	if (!['owner', 'admin'].includes(role)) {
		fail(`--role must be owner | admin (got "${role}").`);
	}

	return {
		githubOrg,
		ownerEmail,
		repo: flags['repo'],
		orgName: flags['org-name'],
		orgId: flags['org-id'],
		brainId: flags['brain-id'],
		role,
		operatorEmail: flags['operator-email'],
		apply: applyRaw as Args['apply'],
		out: flags['out']
	};
}

// ---------- helpers ----------

function fail(msg: string): never {
	console.error(`\n✗ ${msg}\n`);
	process.exit(1);
}

function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

// SQLite string literal: wrap in single quotes, double any embedded quote.
function sqlStr(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

function httpStatus(err: unknown): number | undefined {
	return typeof err === 'object' && err !== null && 'status' in err
		? (err as { status?: number }).status
		: undefined;
}

// ---------- main ----------

async function main() {
	const args = parseArgs(process.argv.slice(2));

	await loadDevVarsIntoEnv();
	const appId = process.env.GITHUB_APP_ID;
	const privateKeyBase64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
	const appSlug = process.env.GITHUB_APP_SLUG ?? 'the Isomorphic App';
	if (!appId || !privateKeyBase64) {
		fail(
			'Missing GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_BASE64 in .dev.vars. Run `pnpm bootstrap` first.'
		);
	}
	const operatorEmail = args.operatorEmail ?? process.env.OPERATOR_EMAIL;
	if (!operatorEmail) {
		fail(
			'No operator email. Pass --operator-email <you@example.com> or set OPERATOR_EMAIL in .dev.vars.\n' +
				'This is the founding-operator account whose id fills created_by / invited_by — NOT the customer.'
		);
	}
	if (operatorEmail.toLowerCase() === args.ownerEmail.toLowerCase()) {
		fail(
			`--operator-email and --owner-email are the same (${operatorEmail}). The operator is YOU (the platform ` +
				`admin); the owner is the CUSTOMER who signs in. They must differ.`
		);
	}

	const creds: AppCreds = { appId: Number(appId), privateKeyBase64 };

	// 1. Resolve the customer's installation from GitHub (App JWT).
	console.log(`→ Resolving the App installation on GitHub org "${args.githubOrg}"…`);
	let installationId: number;
	try {
		const app = appOctokit(creds);
		const { data } = await app.rest.apps.getOrgInstallation({ org: args.githubOrg });
		installationId = data.id;
		console.log(`  installation_id = ${installationId}`);
	} catch (err) {
		if (httpStatus(err) === 404) {
			fail(
				`The Isomorphic App isn't installed on "${args.githubOrg}".\n` +
					`Have the customer install it first:\n` +
					`  https://github.com/apps/${appSlug}/installations/new\n` +
					`then re-run this command.`
			);
		}
		throw err;
	}

	// 2. If adopting a repo, verify the installation can actually reach it.
	if (args.repo) {
		console.log(`→ Verifying the installation can access ${args.githubOrg}/${args.repo}…`);
		try {
			const io = await installationOctokit(creds, installationId);
			await io.rest.repos.get({ owner: args.githubOrg, repo: args.repo });
			console.log('  reachable ✓');
		} catch (err) {
			const status = httpStatus(err);
			if (status === 404 || status === 403) {
				fail(
					`The installation can't access ${args.githubOrg}/${args.repo}.\n` +
						`Add the repo to the installation (org Settings → GitHub Apps → Isomorphic → Configure,\n` +
						`or switch it to "All repositories"), then re-run.`
				);
			}
			throw err;
		}
	} else {
		console.log(
			'→ No --repo given; skipping brain adoption (customer can run connect_brain later).'
		);
	}

	// 3. Build the SQL.
	const orgSlug = slug(args.githubOrg);
	const orgId = args.orgId ?? `org-${orgSlug}`;
	const orgName = args.orgName ?? args.githubOrg;
	const brainId = args.brainId ?? (args.repo ? `brain-${slug(args.repo)}` : undefined);
	const inviteId = `inv-${orgSlug}-owner`;

	// created_by / invited_by resolve to the OPERATOR's app_users.user_id by email
	// (the table the FK points at), via a SELECT subquery in each statement below.
	// The operator must have signed into the app at least once for that row to exist.
	const statements: string[] = [];

	statements.push(
		`-- Customer org (Model B: uses THEIR installation token, not the platform's).\n` +
			`INSERT OR IGNORE INTO orgs\n` +
			`  (org_id, name, model, installation_id, brain_owner, github_org_login, created_by)\n` +
			`  SELECT ${sqlStr(orgId)}, ${sqlStr(orgName)}, 'customer', ${installationId},\n` +
			`         ${sqlStr(args.githubOrg)}, ${sqlStr(args.githubOrg)}, user_id\n` +
			`    FROM app_users WHERE email = ${sqlStr(operatorEmail)};`
	);

	if (args.repo && brainId) {
		statements.push(
			`-- Adopt the existing KB repo as the org's first brain (no scaffold).\n` +
				`INSERT OR IGNORE INTO brains (brain_id, org_id, repo_owner, repo_name, visibility)\n` +
				`  VALUES (${sqlStr(brainId)}, ${sqlStr(orgId)}, ${sqlStr(args.githubOrg)}, ${sqlStr(args.repo)}, 'org');`
		);
	}

	statements.push(
		`-- Pre-invite the owner by email. First magic-link sign-in joins THIS org\n` +
			`-- (provisionOrgForUser consumes the invite) instead of auto-provisioning a\n` +
			`-- personal brain. token_hash unused for the email-match path; far-future\n` +
			`-- expiry keeps it pending until claimed.\n` +
			`INSERT OR IGNORE INTO invitations\n` +
			`  (invite_id, org_id, email, role, invited_by, token_hash, expires_at)\n` +
			`  SELECT ${sqlStr(inviteId)}, ${sqlStr(orgId)}, ${sqlStr(args.ownerEmail)}, ${sqlStr(args.role)},\n` +
			`         user_id, '', '2099-12-31 00:00:00'\n` +
			`    FROM app_users WHERE email = ${sqlStr(operatorEmail)};`
	);

	const header =
		`-- Generated by \`pnpm onboard-org\` — Model-B onboarding for ${args.githubOrg}.\n` +
		`-- operator=${operatorEmail}  owner=${args.ownerEmail}  installation=${installationId}\n` +
		`-- Apply via: pnpm onboard-org … --apply remote  (uses \`d1 execute --command\`, not\n` +
		`-- --file: --file goes through D1's /import endpoint, which 401s with an OAuth token).\n`;
	const sql = header + '\n' + statements.join('\n\n') + '\n';

	// Comment-free form for `--command`. Two reasons we execute via --command, not
	// --file: (1) --file uses D1's /import endpoint, which returns Authentication
	// error 10000 with an OAuth token that lacks the import scope (whereas --command
	// hits /query and works); (2) yargs treats a leading `--` as end-of-options, so
	// the --command value must not start with a `-- comment` line. Stripping comments
	// solves both. --command accepts the multiple semicolon-separated statements.
	const applySql = sql
		.split('\n')
		.filter((line) => !/^\s*--/.test(line) && line.trim() !== '')
		.join('\n');

	// 4. Write the seed to ops/seeds-real/ (gitignored) for the record.
	const outPath =
		args.out ??
		fileURLToPath(new URL(`../ops/seeds-real/seed-${orgSlug}-org.sql`, import.meta.url));
	await mkdir(fileURLToPath(new URL('../ops/seeds-real/', import.meta.url)), { recursive: true });
	await writeFile(outPath, sql, 'utf8');

	console.log('\n' + '─'.repeat(72));
	console.log(sql);
	console.log('─'.repeat(72));
	console.log(`\n✓ Wrote ${outPath}`);

	// 5. Apply, if asked.
	if (args.apply === 'none') {
		console.log(
			'\nDry run (no --apply). To write the rows:\n' +
				`  pnpm onboard-org … --apply both     # local + remote D1\n` +
				`Then the owner (${args.ownerEmail}) signs in and lands in "${orgName}".`
		);
		return;
	}

	const targets = args.apply === 'both' ? (['local', 'remote'] as const) : ([args.apply] as const);
	for (const target of targets) {
		console.log(`\n→ Applying to ${target} D1…`);
		const res = spawnSync(
			'pnpm',
			['exec', 'wrangler', 'd1', 'execute', 'platform-db', `--${target}`, '--command', applySql],
			{ stdio: 'inherit' }
		);
		if (res.status !== 0) {
			fail(`wrangler d1 execute failed for ${target} D1 (exit ${res.status}).`);
		}
	}
	console.log(
		`\n✓ Done. ${args.ownerEmail} can now sign in and will land in "${orgName}" as ${args.role}.` +
			(args.repo ? '' : `\n  No brain yet — have them run connect_brain to adopt a repo.`)
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
