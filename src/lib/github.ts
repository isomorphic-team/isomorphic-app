// GitHub App auth helpers.
//
// Mental model:
//   1. JWT = signed locally with the App's PEM private key. Authenticates AS THE APP.
//      Used for App-level endpoints (list installations, exchange manifest codes).
//   2. Installation token = fetched by calling GitHub WITH the JWT. Authenticates
//      AS A SPECIFIC INSTALLATION on a specific account. Used for repo work.
//      Lasts 1 hour. @octokit/auth-app caches and refreshes it for us.

import { App, Octokit } from 'octokit';

// ---------- Base64 PEM round-trip (env vars hate multi-line strings) ----------
// btoa/atob are web-standard and work in both Node (>=16) and Cloudflare Workers,
// so this module is portable across runtimes. PEMs are ASCII, so single-byte safe.

export function encodePrivateKey(pem: string): string {
	return btoa(pem);
}

export function decodePrivateKey(base64: string): string {
	return atob(base64);
}

// ---------- Manifest code exchange ----------
// One-time call after user submits the manifest form. The `code` arrives via
// the redirect_url; we trade it for the App's actual credentials.

export interface ManifestConversion {
	id: number;
	slug: string;
	owner: { login: string; type: string };
	name: string;
	html_url: string;
	client_id: string;
	client_secret: string;
	webhook_secret: string | null;
	pem: string;
}

export async function exchangeManifestCode(code: string): Promise<ManifestConversion> {
	const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
		method: 'POST',
		headers: {
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28'
		}
	});
	if (!res.ok) {
		throw new Error(`Manifest exchange failed: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as ManifestConversion;
}

// ---------- Octokit factories ----------

export interface AppCreds {
	appId: number;
	privateKeyBase64: string;
}

export function createApp(creds: AppCreds): App {
	return new App({
		appId: creds.appId,
		privateKey: decodePrivateKey(creds.privateKeyBase64)
	});
}

// App-authed Octokit. Use only for App-level reads (installations, App metadata).
// Cannot touch repo contents — repos are scoped to installations, not the App.
export function appOctokit(creds: AppCreds) {
	return createApp(creds).octokit;
}

// Installation-authed Octokit. The workhorse for repo CRUD.
// Returns a fresh Octokit whose token is auto-refreshed by @octokit/auth-app.
export async function installationOctokit(creds: AppCreds, installationId: number) {
	return createApp(creds).getInstallationOctokit(installationId);
}

// Token-authed Octokit: the single-user alternative to an App installation.
//
// Every call a brain repo needs (the git data API, repos.getContent, the batched
// GraphQL blob reads, pulls.*) is available to a fine-grained PAT with Contents and
// Pull requests write on that repository. A token cannot act as an App across many
// installations, so this is single-tenant only.
//
// Not auto-refreshed: a PAT expires, and a 401 from GitHub is clearer than a refresh
// loop that cannot succeed.
export function tokenOctokit(token: string): Octokit {
	return new Octokit({ auth: token });
}

// ---------- static (single-tenant) mode: which credential, or which error ----------

// What a static-mode deployment resolved to. The caller turns this into an Octokit;
// the choosing and the refusing happen here, where they can be tested.
export type StaticAuth =
	| { kind: 'token'; token: string; owner: string; repo: string }
	| { kind: 'installation'; installationId: number; owner: string; repo: string };

// AUTH_MODE=static is the documented SELF-HOSTING entry point, so these two error
// messages are the first thing someone standing this up hits when their config is
// incomplete. They were written inline in a private method on McpSession and had no
// test at all, which for the errors a stranger reads is the wrong way round.
//
// GITHUB_TOKEN wins over the App installation when both are set: it is the simpler
// path and naming it is the more specific act.
export function staticAuth(env: {
	BRAIN_REPO_OWNER?: string;
	BRAIN_REPO_NAME?: string;
	GITHUB_TOKEN?: string;
	GITHUB_APP_INSTALLATION_ID?: string;
}): StaticAuth {
	const owner = env.BRAIN_REPO_OWNER?.trim();
	const repo = env.BRAIN_REPO_NAME?.trim();
	if (!owner || !repo) {
		throw new Error(
			'AUTH_MODE=static requires BRAIN_REPO_OWNER and BRAIN_REPO_NAME (which brain to serve), plus either GITHUB_TOKEN (simplest) or GITHUB_APP_INSTALLATION_ID with the platform App credentials. Run `pnpm doctor` to see what is missing.'
		);
	}
	const token = env.GITHUB_TOKEN?.trim();
	if (token) return { kind: 'token', token, owner, repo };

	// Number() on a non-numeric string is NaN, which would reach GitHub as a
	// nonsense installation id and fail far from the cause.
	const installationId = Number(env.GITHUB_APP_INSTALLATION_ID);
	if (!env.GITHUB_APP_INSTALLATION_ID?.trim() || !Number.isFinite(installationId)) {
		throw new Error(
			'AUTH_MODE=static needs a way to reach GitHub: set GITHUB_TOKEN (a fine-grained PAT with Contents and Pull requests write on the brain repo), or set GITHUB_APP_INSTALLATION_ID and the platform App credentials. Run `pnpm doctor` to see what is missing.'
		);
	}
	return { kind: 'installation', installationId, owner, repo };
}
