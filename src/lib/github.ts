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

// Token-authed Octokit: the single-user alternative to the whole App dance.
//
// Every call the brain repo actually needs (the git data API, repos.getContent,
// the batched GraphQL blob reads, pulls.*) is available to a fine-grained PAT with
// Contents and Pull requests write on that one repository. What a token cannot do
// is act as an App across MANY installations, which is the multi-tenant path and
// is why this is single-tenant only.
//
// Deliberately not auto-refreshed: a PAT is a static credential that eventually
// expires, and the failure (a 401 from GitHub) is clearer than a refresh loop that
// cannot succeed.
export function tokenOctokit(token: string): Octokit {
	return new Octokit({ auth: token });
}
