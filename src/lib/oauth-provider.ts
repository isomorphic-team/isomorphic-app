// The OAuth provider for AUTH_MODE=oauth, one per serving origin.
//
// @cloudflare/workers-oauth-provider binds every token to one canonical resource fixed at
// construction. This Worker answers on more than one origin (its own hostname, a version
// preview URL during a deploy, localhost under `wrangler dev`), and each must advertise
// itself: the deploy smoke asserts `<origin>/mcp` on the preview URL before promotion.
// So the resource is `<request origin>/mcp` and a provider is built per origin, rather
// than from PUBLIC_BASE_URL.

import { OAuthProvider, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';

export const MCP_ROUTE = '/mcp';

/** The canonical OAuth resource for an origin: the MCP endpoint clients connect to. */
export function mcpResource(origin: string): string {
	return `${origin}${MCP_ROUTE}`;
}

export type OAuthProviderBase<Env> = Omit<
	OAuthProviderOptions<Env>,
	'apiRoute' | 'apiHandlers' | 'resourceMetadata'
>;

/** Origins a Worker isolate serves are few; the cap only bounds a misrouted host. */
const MAX_CACHED_ORIGINS = 16;

/** Returns the provider for a request's origin, building and caching it on first use. */
export function oauthProviderForOrigin<Env>(
	base: OAuthProviderBase<Env>
): (origin: string) => OAuthProvider<Env> {
	const cache = new Map<string, OAuthProvider<Env>>();
	return (origin) => {
		let provider = cache.get(origin);
		if (!provider) {
			if (cache.size >= MAX_CACHED_ORIGINS) cache.clear();
			provider = new OAuthProvider<Env>({
				...base,
				apiRoute: MCP_ROUTE,
				resourceMetadata: { resource: mcpResource(origin), authorization_servers: [origin] }
			});
			cache.set(origin, provider);
		}
		return provider;
	};
}
