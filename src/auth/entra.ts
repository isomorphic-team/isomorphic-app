// The Auth.js provider for one org's Microsoft Entra directory
// (docs/design/enterprise-identity.md, D4 and D9). Not registered in `buildAuthConfig` yet.
//
// Built per request for the org a sign-in was routed to (`resolveSignInRoute`). The sign-in
// it completes is accepted only if `checkSsoSignIn` passes in the `signIn` callback; that is
// what makes `allowDangerousEmailAccountLinking` safe here.

import MicrosoftEntraID from '@auth/core/providers/microsoft-entra-id';
import { ENTRA_SCOPE, entraIssuer, entraProfile, type EntraClaims } from '../lib/sso.ts';

export function entraProvider(config: {
	clientId: string;
	clientSecret: string;
	tenantId: string;
}) {
	return MicrosoftEntraID({
		clientId: config.clientId,
		clientSecret: config.clientSecret,
		// Always explicit: without it the provider reads process.env, then uses the `common`
		// endpoint, which accepts any tenant. `entraIssuer` throws on anything but a tenant id.
		issuer: entraIssuer(config.tenantId),
		authorization: { params: { scope: ENTRA_SCOPE } },
		// Replaces the provider's own, which fetches a photo from Graph.
		profile: (claims: EntraClaims) => entraProfile(claims),
		// Lets a member who signed in by magic link keep their account on their first sign-in
		// through the provider.
		allowDangerousEmailAccountLinking: true
	});
}
