// GitHub App Manifest. Submitted to GitHub via a form POST during bootstrap;
// GitHub creates the App with these declared permissions/events and returns
// credentials via the redirect_url callback (one-time, holds a temporary code).
//
// Docs: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest

export interface AppManifest {
	name: string;
	url: string;
	description: string;
	public: boolean;
	redirect_url: string;
	setup_url: string;
	setup_on_update: boolean;
	// OAuth user-sign-in callbacks. The MCP server's OAuth provider redirects
	// users to GitHub for sign-in; GitHub returns to one of these URLs.
	callback_urls: string[];
	// If true, GitHub prompts the user to grant user-level OAuth perms during
	// installation, so they're signed in as soon as the App is installed.
	request_oauth_on_install: boolean;
	default_permissions: Record<string, 'read' | 'write'>;
	default_events: string[];
}

export function buildManifest(opts: {
	name: string;
	baseUrl: string;
	homepageUrl?: string;
	// Public origin of the deployed MCP Worker, e.g. https://brain.example.com. The
	// OAuth sign-in callback is registered against it. Omit it and only the localhost
	// callback is registered, which is correct until you deploy: a self-hoster who
	// bootstraps before deploying should not end up with somebody else's domain baked
	// into their App. Add the deployed callback later at
	// github.com/settings/apps/<slug> if you skip it here.
	workerBaseUrl?: string;
}): AppManifest {
	// Always register the local dev callback; add the deployed one when we know it.
	const callbackUrls = ['http://localhost:8787/oauth/github/callback'];
	if (opts.workerBaseUrl) {
		const deployed = `${opts.workerBaseUrl.replace(/\/+$/, '')}/oauth/github/callback`;
		if (!callbackUrls.includes(deployed)) callbackUrls.unshift(deployed);
	}

	return {
		name: opts.name,
		url: opts.homepageUrl ?? 'https://github.com/isomorphic-team/isomorphic-app',
		description: 'LLM-maintained organizational knowledge base',
		// `false` = only the App owner's account can install it. Right for a
		// single-org deployment; a multi-tenant platform flips this to `true`.
		public: false,
		// One-time post-creation redirect carrying a code we exchange for App creds.
		redirect_url: `${opts.baseUrl}/github/manifest-callback`,
		// Per-installation redirect; fires after the user installs (or updates) the App.
		setup_url: `${opts.baseUrl}/github/install-callback`,
		setup_on_update: true,
		// OAuth user-sign-in callbacks. The MCP Worker (separate from this Node-side
		// bootstrap) hosts the user-OAuth flow; GitHub returns the user there after
		// sign-in. Ordered deployed-first purely for legibility in GitHub's UI.
		callback_urls: callbackUrls,
		// Sign the user in to the MCP server right after they install.
		request_oauth_on_install: true,
		default_permissions: {
			// `administration: write` is the non-obvious one — required to CREATE repos.
			// `contents: write` lets us commit; `pull_requests: write` lets the write
			// tools open PRs against a protected brain.
			administration: 'write',
			contents: 'write',
			pull_requests: 'write',
			metadata: 'read'
		},
		// No webhook subscriptions yet. Add `push`, `pull_request` once we wire agents.
		default_events: []
	};
}
