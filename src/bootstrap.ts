// One-shot bootstrap server.
//
// Run with `pnpm bootstrap`. Walks you through:
//   1. Registering the GitHub App via the manifest flow (form POST to GitHub).
//   2. Installing the App on your account.
//   3. Creating + scaffolding the brain repo.
//
// Each step is one route. Credentials are persisted to `.dev.vars` along the
// way so a successful run leaves the rest of the platform ready to use them.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createPrivateKey, randomBytes } from 'node:crypto';
import open from 'open';
import {
	appOctokit,
	decodePrivateKey,
	encodePrivateKey,
	exchangeManifestCode,
	installationOctokit,
	type AppCreds
} from './lib/github.ts';
import { buildManifest } from './manifest.ts';
import { loadDevVarsIntoEnv, readDevVars, writeDevVars } from './persist.ts';
import { createAndScaffoldBrain } from './lib/scaffold-core.ts';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const APP_NAME = process.env.APP_NAME ?? 'isomorphic-mind';
const BRAIN_REPO_NAME = process.env.BRAIN_REPO_NAME ?? 'isomorphic-mind';

await migratePrivateKeyIfPkcs1();
await loadDevVarsIntoEnv();

// CSRF state — generated when /register is rendered, verified on manifest callback.
let manifestState: string | null = null;

const app = new Hono();

// ---------- 1. Landing / register page ----------

app.get('/', (c) => {
	manifestState = randomBytes(16).toString('hex');
	// PUBLIC_BASE_URL is the deployed Worker's origin. It is usually unset on a first
	// run (you have not deployed yet), in which case only the localhost OAuth callback
	// is registered and you add the deployed one to the App later. Setting it in
	// .dev.vars before bootstrapping saves that step.
	const manifest = buildManifest({
		name: APP_NAME,
		baseUrl: BASE_URL,
		workerBaseUrl: process.env.PUBLIC_BASE_URL
	});
	const manifestJson = JSON.stringify(manifest);
	// Personal-account App registration. For an org, use:
	//   https://github.com/organizations/{org}/settings/apps/new
	const action = `https://github.com/settings/apps/new?state=${manifestState}`;

	return c.html(
		page(
			'Register the GitHub App',
			`
		<p>Submitting this form will send the manifest below to GitHub. GitHub
		will create the App with these declared permissions and redirect back
		here with a one-time code we exchange for the App's credentials.</p>

		<form method="post" action="${action}">
			<input type="hidden" name="manifest" value='${escapeHtml(manifestJson)}' />
			<button type="submit">Create <code>${APP_NAME}</code> on GitHub</button>
		</form>

		<details>
			<summary>Inspect the manifest</summary>
			<pre>${escapeHtml(JSON.stringify(manifest, null, 2))}</pre>
		</details>
	`
		)
	);
});

// ---------- 2. Manifest exchange callback ----------

app.get('/github/manifest-callback', async (c) => {
	const code = c.req.query('code');
	const state = c.req.query('state');
	if (!code) return c.text('Missing code', 400);
	if (!manifestState || state !== manifestState) {
		return c.text('State mismatch — possible CSRF. Restart from /', 400);
	}

	const conv = await exchangeManifestCode(code);

	await writeDevVars({
		GITHUB_APP_ID: String(conv.id),
		GITHUB_APP_SLUG: conv.slug,
		GITHUB_APP_CLIENT_ID: conv.client_id,
		GITHUB_APP_CLIENT_SECRET: conv.client_secret,
		GITHUB_APP_WEBHOOK_SECRET: conv.webhook_secret ?? '',
		GITHUB_APP_PRIVATE_KEY_BASE64: encodePrivateKey(toPkcs8Pem(conv.pem))
	});
	// Reload so subsequent routes see the new values.
	await loadDevVarsIntoEnv();

	const installUrl = `https://github.com/apps/${conv.slug}/installations/new`;

	return c.html(
		page(
			'App registered',
			`
		<p>App <code>${escapeHtml(conv.name)}</code> created (App ID
		<code>${conv.id}</code>, owner <code>${escapeHtml(conv.owner.login)}</code>).</p>
		<p>Credentials saved to <code>.dev.vars</code>.</p>
		<p>Next: install it on your account so it has somewhere to act.</p>
		<a class="button" href="${installUrl}">Install <code>${escapeHtml(conv.slug)}</code></a>
	`
		)
	);
});

// ---------- 3. Post-install callback: create + scaffold the brain ----------

app.get('/github/install-callback', async (c) => {
	const installationId = c.req.query('installation_id');
	if (!installationId) return c.text('Missing installation_id', 400);

	await writeDevVars({ GITHUB_APP_INSTALLATION_ID: installationId });
	await loadDevVarsIntoEnv();

	const creds = readCredsFromEnv();

	// Inspect the installation to find the account it's installed on. App auth
	// can only create repos on Organizations, not Users — fail loud on user
	// installs so the user knows what to do.
	const { data: installation } = await appOctokit(creds).rest.apps.getInstallation({
		installation_id: Number(installationId)
	});
	const account = installation.account;
	const ownerLogin = account && 'login' in account ? account.login : '(unknown)';
	const ownerType = account && 'type' in account ? account.type : '(unknown)';

	if (ownerType !== 'Organization') {
		const slug = process.env.GITHUB_APP_SLUG ?? APP_NAME;
		return c.html(
			page(
				'Install on an organization',
				`
			<p>The App is installed on <strong>${escapeHtml(ownerType)}</strong> account
			<code>${escapeHtml(ownerLogin)}</code>. GitHub Apps can only create new repos
			when installed on an <strong>Organization</strong> (the
			<code>administration: write</code> permission isn't granted to App
			installations on personal accounts).</p>
			<p>To proceed:</p>
			<ol>
				<li>Create a free GitHub org:
					<a href="https://github.com/account/organizations/new" target="_blank">
						github.com/account/organizations/new
					</a>
				</li>
				<li>Install the App on the new org:
					<a href="https://github.com/apps/${escapeHtml(slug)}/installations/new" target="_blank">
						github.com/apps/${escapeHtml(slug)}/installations/new
					</a>
				</li>
				<li>GitHub will redirect back here automatically with the new
					<code>installation_id</code> and the brain will scaffold.</li>
			</ol>
			<p>You can leave the user-account install in place or remove it — it's harmless.</p>
		`
			),
			400
		);
	}

	// Platform-provisioning model: this install is the ONE platform installation
	// on the ONE platform org. We record the org login + installation id; the MCP
	// Worker auto-creates a per-user brain under this org on each user's first
	// authenticated request. The admin does not pre-create user brains here.
	await writeDevVars({
		PLATFORM_ORG: ownerLogin,
		PLATFORM_INSTALLATION_ID: installationId
	});
	await loadDevVarsIntoEnv();

	// Probe that repo creation actually works on this installation (catches a
	// mis-scoped install before the first real user hits it). We scaffold a
	// canary brain rather than leave the success purely theoretical; it doubles
	// as the admin's own brain.
	const octokit = await installationOctokit(creds, Number(installationId));
	let probeNote: string;
	try {
		const brain = await createAndScaffoldBrain(octokit, {
			org: ownerLogin,
			name: BRAIN_REPO_NAME,
			description: 'Platform canary brain — verifies repo-create permission'
		});
		probeNote = `<p>Verified repo creation by scaffolding
			<a href="${brain.htmlUrl}"><code>${escapeHtml(brain.owner)}/${escapeHtml(brain.name)}</code></a>
			(<code>${brain.commitSha.slice(0, 7)}</code>).</p>`;
	} catch (err) {
		const exists =
			typeof err === 'object' &&
			err !== null &&
			'status' in err &&
			(err as { status: number }).status === 422;
		probeNote = exists
			? `<p>Canary repo <code>${escapeHtml(BRAIN_REPO_NAME)}</code> already exists — repo-create
				permission previously verified.</p>`
			: `<p><strong>Warning:</strong> could not create a canary repo
				(<code>${escapeHtml(String(err))}</code>). Auto-provisioning may fail until this is resolved.</p>`;
	}

	return c.html(
		page(
			'Platform ready',
			`
		<p>Platform App installed on org <code>${escapeHtml(ownerLogin)}</code>
		(installation <code>${escapeHtml(installationId)}</code>).</p>
		<p>Recorded <code>PLATFORM_ORG</code> and <code>PLATFORM_INSTALLATION_ID</code> in
		<code>.dev.vars</code>. With <code>AUTO_PROVISION=true</code>, each user's brain is
		created automatically under this org on their first MCP request — they never
		install anything or see GitHub.</p>
		${probeNote}
		<p>You can close this window. The bootstrap server is still running —
		Ctrl+C in the terminal to stop it.</p>
	`
		)
	);
});

// ---------- helpers ----------

// GitHub issues App private keys in PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`).
// `universal-github-app-jwt` (used by octokit's App auth) only accepts PKCS#8.
// Node's `createPrivateKey` parses both; exporting as PKCS#8 normalizes.
function toPkcs8Pem(pem: string): string {
	return createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString();
}

// One-shot: rewrite an existing PKCS#1 key in .dev.vars to PKCS#8.
// Runs before loadDevVarsIntoEnv so the converted value is what gets loaded.
async function migratePrivateKeyIfPkcs1(): Promise<void> {
	const existing = await readDevVars();
	const b64 = existing.GITHUB_APP_PRIVATE_KEY_BASE64;
	if (!b64) return;
	const pem = decodePrivateKey(b64);
	if (!pem.includes('BEGIN RSA PRIVATE KEY')) return;
	await writeDevVars({
		GITHUB_APP_PRIVATE_KEY_BASE64: encodePrivateKey(toPkcs8Pem(pem))
	});
	console.log('  Migrated GITHUB_APP_PRIVATE_KEY_BASE64 from PKCS#1 to PKCS#8.');
}

function readCredsFromEnv(): AppCreds {
	const appId = process.env.GITHUB_APP_ID;
	const pk = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
	if (!appId || !pk) {
		throw new Error('Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY_BASE64 in .dev.vars');
	}
	return { appId: Number(appId), privateKeyBase64: pk };
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} · isomorphic-mind</title>
<style>
	body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.6; color: #1a1a1a; }
	h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
	code { background: #f4f4f5; padding: 0.125rem 0.375rem; border-radius: 4px; font-size: 0.9em; }
	pre { background: #f4f4f5; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.85em; }
	button, .button { display: inline-block; background: #0f172a; color: white; padding: 0.625rem 1.25rem; border-radius: 6px; text-decoration: none; border: 0; font-size: 1rem; cursor: pointer; }
	button:hover, .button:hover { background: #1e293b; }
	details { margin-top: 1.5rem; }
	summary { cursor: pointer; color: #525252; }
	a { color: #1d4ed8; }
</style>
</head>
<body>
	<h1>${escapeHtml(title)}</h1>
	${body}
</body>
</html>`;
}

// ---------- start ----------

serve({ fetch: app.fetch, port: PORT }, (info) => {
	const url = `http://localhost:${info.port}`;
	console.log(`\n  Bootstrap server: ${url}`);
	console.log('  Opening in your default browser...\n');
	open(url).catch(() => {
		console.log(`  (Couldn't open browser automatically; visit ${url} manually.)`);
	});
});

// Quiet check: log if creds are already set (re-running bootstrap).
const existing = await readDevVars();
if (existing.GITHUB_APP_ID) {
	console.log(
		`  Note: GITHUB_APP_ID=${existing.GITHUB_APP_ID} already in .dev.vars.\n` +
			`  Re-registering will overwrite it.\n`
	);
}
