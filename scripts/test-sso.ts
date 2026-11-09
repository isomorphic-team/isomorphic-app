// Golden test for enterprise identity's offline parts: verified domains, sign-in routing and
// the acceptance of a provider sign-in. No network: the DNS lookup is a stubbed fetch, and D1
// runs the REAL migrations over node:sqlite.
//
//   pnpm test:sso
//
// What this exists to catch:
//
//   1. A DOMAIN VERIFIED WITHOUT PROOF. Only a TXT answer carrying this org's own challenge
//      verifies a domain, one org at a time, and a resolver failure proves nothing either way.
//   2. A LAPSED DOMAIN STILL ROUTING. A stale verified domain is looked up again before it
//      routes a sign-in, and a record that is gone stops it.
//   3. AN ADDRESS ROUTED TO THE WRONG DOOR. Unverified, unentitled and unconnected domains get
//      the magic link; an enforced domain never does.
//   4. A SIGN-IN ACCEPTED FROM THE WRONG DIRECTORY OR FOR ANOTHER ORG'S ADDRESS. The token's
//      tenant must be the connected one and the address's domain must be verified for that org.
//   5. THE PROVIDER BUILT UNPINNED. It always carries one tenant's issuer, asks Graph for
//      nothing, and cannot be built for a shared endpoint.

import { entraProvider } from '../src/auth/entra.ts';
import { FEATURES } from '../src/lib/entitlements.ts';
import {
	DOH_ENDPOINT,
	DOMAIN_RECHECK_MS,
	afterTxtCheck,
	checkDomainTxt,
	claimDomain,
	currentVerifiedDomain,
	emailDomain,
	listOrgDomains,
	normalizeDomain,
	recheckDue,
	removeDomain,
	txtAnswerText,
	txtRecordValue,
	verifiedDomain,
	verifyOrgDomain
} from '../src/lib/org-domains.ts';
import {
	ENTRA_SCOPE,
	allowSsoSignIn,
	checkSsoSignIn,
	chooseSignInRoute,
	entraAddress,
	entraIssuer,
	entraProfile,
	getIdentityConnection,
	normalizeTenantId,
	removeIdentityConnection,
	resolveSignInRoute,
	setIdentityConnection,
	type IdentityConnection
} from '../src/lib/sso.ts';
import { localD1 } from '../src/local/d1-sqlite.ts';
import { entitlementSql } from '../ee/entitlements.ts';
import { checker } from './check.ts';

const { check, done } = checker('sso checks');

const NOW = Date.UTC(2026, 0, 15);
const DAY = 24 * 60 * 60 * 1000;
const TENANT_A = '11111111-2222-3333-4444-555555555555';
const TENANT_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// A resolver that answers from a table of domain -> TXT strings. `calls` counts lookups.
type Zone = Record<string, string[] | 'servfail' | 'nxdomain' | 'http-error' | 'throw'>;
function resolver(zone: Zone) {
	const state = { calls: 0, lastUrl: '', lastAccept: '' };
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		state.calls++;
		state.lastUrl = String(input);
		state.lastAccept = new Headers(init?.headers).get('accept') ?? '';
		const name = new URL(String(input)).searchParams.get('name') ?? '';
		const entry = zone[name] ?? 'nxdomain';
		if (entry === 'throw') throw new Error('network down');
		if (entry === 'http-error') return new Response('bad gateway', { status: 502 });
		if (entry === 'servfail') return Response.json({ Status: 2 });
		if (entry === 'nxdomain') return Response.json({ Status: 3 });
		return Response.json({
			Status: 0,
			Answer: entry.map((data) => ({ name, type: 16, TTL: 300, data }))
		});
	}) as typeof fetch;
	return { fetchFn, state };
}

console.log('\nDomains and addresses');
{
	check(
		'a domain is lowercased and loses a trailing dot',
		normalizeDomain(' Example.COM. ') === 'example.com'
	);
	check('a subdomain is a domain', normalizeDomain('mail.example.co.uk') === 'mail.example.co.uk');
	for (const bad of [
		'',
		'localhost',
		'example',
		'a@example.com',
		'https://example.com',
		'example.com/x',
		'exa mple.com',
		'-a.example.com',
		'10.0.0.1',
		'example.com:443',
		'.example.com'
	])
		check(`not a domain: ${JSON.stringify(bad)}`, normalizeDomain(bad) === null);
	check('an address gives its domain', emailDomain('Ada@Example.com') === 'example.com');
	for (const bad of ['example.com', '@example.com', 'a@b@example.com', 'ada@localhost'])
		check(`no domain from ${JSON.stringify(bad)}`, emailDomain(bad) === null);
}

console.log('\nThe TXT lookup (1)');
{
	const want = txtRecordValue('abc123');
	check(
		'quoted chunks of one answer are concatenated',
		txtAnswerText('"isomorphic-" "domain"') === 'isomorphic-domain'
	);
	check('an unquoted answer is read as it is', txtAnswerText(' plain ') === 'plain');

	const found = resolver({ 'example.com': ['"v=spf1 -all"', `"${want}"`] });
	check(
		'the record among others is found',
		(await checkDomainTxt('example.com', 'abc123', found.fetchFn)) === 'found'
	);
	check(
		'the lookup is a JSON TXT query for the domain',
		found.state.lastUrl === `${DOH_ENDPOINT}?name=example.com&type=TXT` &&
			found.state.lastAccept === 'application/dns-json'
	);
	const split = resolver({ 'example.com': [`"${want.slice(0, 10)}" "${want.slice(10)}"`] });
	check(
		'a record split into chunks is found',
		(await checkDomainTxt('example.com', 'abc123', split.fetchFn)) === 'found'
	);

	const other = resolver({
		'example.com': [`"${txtRecordValue('someone-else')}"`, `"${want}-and-more"`, `"x ${want}"`]
	});
	check(
		'another challenge, a longer value or a prefix is not the record',
		(await checkDomainTxt('example.com', 'abc123', other.fetchFn)) === 'missing'
	);
	const cname = resolver({});
	cname.fetchFn = (async () =>
		Response.json({ Status: 0, Answer: [{ type: 5, data: `"${want}"` }] })) as typeof fetch;
	check(
		'a non-TXT answer is not the record',
		(await checkDomainTxt('example.com', 'abc123', cname.fetchFn)) === 'missing'
	);
	check(
		'no such domain is missing',
		(await checkDomainTxt('nope.example', 'abc123', resolver({}).fetchFn)) === 'missing'
	);
	for (const failure of ['servfail', 'http-error', 'throw'] as const)
		check(
			`${failure} proves nothing`,
			(await checkDomainTxt(
				'example.com',
				'abc123',
				resolver({ 'example.com': failure }).fetchFn
			)) === 'unknown'
		);

	const verified = { verifiedAt: NOW - DAY, lastCheckedAt: NOW - DAY };
	const fresh = { verifiedAt: null, lastCheckedAt: null };
	check('found verifies now', afterTxtCheck(fresh, 'found', NOW).verifiedAt === NOW);
	const kept = afterTxtCheck(verified, 'found', NOW);
	check(
		'found keeps the first verification time',
		kept.verifiedAt === NOW - DAY && kept.lastCheckedAt === NOW
	);
	const gone = afterTxtCheck(verified, 'missing', NOW);
	check('missing unverifies', gone.verifiedAt === null && gone.lastCheckedAt === NOW);
	const same = afterTxtCheck(verified, 'unknown', NOW);
	check(
		'unknown changes nothing',
		same.verifiedAt === NOW - DAY && same.lastCheckedAt === NOW - DAY
	);
	check('unknown does not verify', afterTxtCheck(fresh, 'unknown', NOW).verifiedAt === null);
	check('never checked is due', recheckDue({ lastCheckedAt: null }, NOW));
	check('checked a day ago is due', recheckDue({ lastCheckedAt: NOW - DOMAIN_RECHECK_MS }, NOW));
	check('checked an hour ago is not', !recheckDue({ lastCheckedAt: NOW - 60 * 60 * 1000 }, NOW));
}

const { db, sqlite } = localD1();
const entitle = (orgId: string, expiresAt?: number) =>
	db
		.prepare(
			entitlementSql({
				kind: 'grant',
				orgId,
				feature: FEATURES.enterprise,
				source: 'manual',
				now: NOW,
				expiresAt
			})
		)
		.run();
const verify = (orgId: string, domain: string, challenge: string, now = NOW) =>
	verifyOrgDomain(
		db,
		orgId,
		domain,
		now,
		resolver({ [domain]: [`"${txtRecordValue(challenge)}"`] }).fetchFn
	);

console.log('\nClaiming and verifying a domain (1)');
{
	check(
		'a bad name claims nothing',
		(await claimDomain(db, { orgId: 'o1', domain: 'nope', userId: 'u1', now: NOW })) === null
	);
	const a = await claimDomain(db, { orgId: 'o1', domain: 'Example.com', userId: 'u1', now: NOW });
	check(
		'a claim is stored normalized and unverified',
		a?.domain === 'example.com' && a.verifiedAt === null && !a.ssoEnforced
	);
	check('the challenge is 40 hex characters', /^[0-9a-f]{40}$/.test(a?.challenge ?? ''));
	const again = await claimDomain(db, {
		orgId: 'o1',
		domain: 'example.com',
		userId: 'u2',
		now: NOW + 5
	});
	check(
		'claiming again keeps the challenge',
		again?.challenge === a?.challenge && again?.createdAt === NOW
	);
	const b = await claimDomain(db, { orgId: 'o2', domain: 'example.com', userId: 'u9', now: NOW });
	check('a second org gets its own challenge', !!b && b.challenge !== a?.challenge);
	check('an unverified claim holds nothing', (await verifiedDomain(db, 'example.com')) === null);

	const none = await verifyOrgDomain(db, 'o1', 'example.com', NOW, resolver({}).fetchFn);
	check(
		'no record does not verify',
		none.status === 'missing' && (await verifiedDomain(db, 'example.com')) === null
	);
	const down = await verifyOrgDomain(
		db,
		'o1',
		'example.com',
		NOW,
		resolver({ 'example.com': 'servfail' }).fetchFn
	);
	check(
		'a resolver failure does not verify',
		down.status === 'unknown' && (await verifiedDomain(db, 'example.com')) === null
	);
	const wrong = await verify('o1', 'example.com', b!.challenge);
	check("another org's challenge does not verify", wrong.status === 'missing');
	check(
		'an unclaimed domain cannot be verified',
		(await verify('o1', 'other.example', 'x')).status === 'not-claimed'
	);

	const ok = await verify('o1', 'example.com', a!.challenge);
	check('its own challenge verifies', ok.status === 'verified' && ok.domain.verifiedAt === NOW);
	check(
		'the verified holder is that org',
		(await verifiedDomain(db, 'example.com'))?.orgId === 'o1'
	);
	const taken = await verify('o2', 'example.com', b!.challenge);
	check('a second org cannot verify a held domain', taken.status === 'taken');
	let threw = false;
	try {
		await db.prepare(`UPDATE org_domains SET verified_at = ?1 WHERE org_id = 'o2'`).bind(NOW).run();
	} catch {
		threw = true;
	}
	check('the schema refuses two verified holders', threw);
	check(
		'an org lists its claims',
		(await listOrgDomains(db, 'o1')).map((d) => d.domain).join() === 'example.com'
	);
}

console.log('\nA stale domain is looked up again (2)');
{
	const challenge = (await listOrgDomains(db, 'o1'))[0].challenge;
	const record = { 'example.com': [`"${txtRecordValue(challenge)}"`] };

	const soon = resolver(record);
	const d1 = await currentVerifiedDomain(db, 'example.com', NOW + 60_000, soon.fetchFn);
	check('a fresh domain routes without a lookup', d1?.orgId === 'o1' && soon.state.calls === 0);

	const later = resolver(record);
	const d2 = await currentVerifiedDomain(db, 'example.com', NOW + DAY, later.fetchFn);
	check(
		'a stale one is looked up once and kept',
		d2?.lastCheckedAt === NOW + DAY && later.state.calls === 1
	);
	check('and keeps its first verification time', d2?.verifiedAt === NOW);

	const outage = resolver({ 'example.com': 'throw' });
	const d3 = await currentVerifiedDomain(db, 'example.com', NOW + 3 * DAY, outage.fetchFn);
	check('a resolver failure keeps it routing', d3?.orgId === 'o1' && outage.state.calls === 1);
	check(
		'and leaves it due',
		(await verifiedDomain(db, 'example.com'))?.lastCheckedAt === NOW + DAY
	);

	const lapsed = resolver({ 'example.com': ['"v=spf1 -all"'] });
	const d4 = await currentVerifiedDomain(db, 'example.com', NOW + 3 * DAY, lapsed.fetchFn);
	check(
		'a record that is gone stops it routing',
		d4 === null && (await verifiedDomain(db, 'example.com')) === null
	);
	check(
		'the claim and its challenge stay',
		(await listOrgDomains(db, 'o1'))[0].challenge === challenge
	);
	check(
		'an unknown domain needs no lookup',
		(await currentVerifiedDomain(db, 'nobody.example', NOW, lapsed.fetchFn)) === null &&
			lapsed.state.calls === 1
	);

	check(
		'it verifies again with the same record',
		(await verify('o1', 'example.com', challenge, NOW + 4 * DAY)).status === 'verified'
	);
}

console.log('\nIdentity connections');
{
	check('a tenant id is lowercased', normalizeTenantId(` ${TENANT_B.toUpperCase()} `) === TENANT_B);
	for (const bad of [
		'common',
		'organizations',
		'consumers',
		'',
		'example.com',
		TENANT_A + '/x',
		TENANT_A.replace(/-/g, '')
	])
		check(`not a tenant id: ${JSON.stringify(bad)}`, normalizeTenantId(bad) === null);
	check(
		'the issuer names one tenant, with no trailing slash',
		entraIssuer(TENANT_A) === `https://login.microsoftonline.com/${TENANT_A}/v2.0`
	);
	let threw = false;
	try {
		entraIssuer('common');
	} catch {
		threw = true;
	}
	check('there is no issuer for a shared endpoint', threw);

	check(
		'a bad tenant id connects nothing',
		(await setIdentityConnection(db, {
			orgId: 'o1',
			tenantId: 'common',
			userId: 'u1',
			now: NOW
		})) === null
	);
	const c = await setIdentityConnection(db, {
		orgId: 'o1',
		tenantId: TENANT_B,
		userId: 'u1',
		now: NOW
	});
	check(
		'an org connects to a directory',
		c?.tenantId === TENANT_B && c.provider === 'microsoft-entra-id'
	);
	const c2 = await setIdentityConnection(db, {
		orgId: 'o1',
		tenantId: TENANT_A.toUpperCase(),
		userId: 'u1',
		now: NOW + 1
	});
	check(
		'connecting again replaces it',
		c2?.tenantId === TENANT_A && (await getIdentityConnection(db, 'o1'))?.tenantId === TENANT_A
	);
	check('another org has none', (await getIdentityConnection(db, 'o2')) === null);
	const columns = sqlite
		.prepare(`SELECT name FROM pragma_table_info('identity_connections')`)
		.all() as { name: string }[];
	check(
		'the table holds no credential',
		columns
			.map((c) => c.name)
			.sort()
			.join() === 'created_at,created_by,org_id,provider,tenant_id'
	);
}

console.log('\nRouting an address (3)');
{
	const connection = (await getIdentityConnection(db, 'o1')) as IdentityConnection;
	const open = { ssoEnforced: false };
	const enforced = { ssoEnforced: true };
	const kind = (r: ReturnType<typeof chooseSignInRoute>) => r.kind;
	check(
		'no verified domain: magic link',
		kind(chooseSignInRoute({ domain: null, entitled: true, connection })) === 'magic-link'
	);
	check(
		'not entitled: magic link',
		kind(chooseSignInRoute({ domain: open, entitled: false, connection })) === 'magic-link'
	);
	check(
		'not entitled, even enforced: magic link',
		kind(chooseSignInRoute({ domain: enforced, entitled: false, connection: null })) ===
			'magic-link'
	);
	check(
		'entitled and connected: the provider',
		kind(chooseSignInRoute({ domain: open, entitled: true, connection })) === 'sso'
	);
	check(
		'entitled, not connected: magic link',
		kind(chooseSignInRoute({ domain: open, entitled: true, connection: null })) === 'magic-link'
	);
	check(
		'enforced and connected: the provider',
		kind(chooseSignInRoute({ domain: enforced, entitled: true, connection })) === 'sso'
	);
	check(
		'enforced, not connected: refused',
		kind(chooseSignInRoute({ domain: enforced, entitled: true, connection: null })) === 'refused'
	);

	const dns = resolver({});
	const route = (email: string, now = NOW + 4 * DAY) =>
		resolveSignInRoute(db, email, now, dns.fetchFn);
	check(
		'a verified domain without an entitlement: magic link',
		(await route('ada@example.com')).kind === 'magic-link'
	);
	await entitle('o1');
	const sso = await route('Ada@Example.com');
	check(
		'with the entitlement: the provider, for that org',
		sso.kind === 'sso' && sso.connection.orgId === 'o1' && sso.connection.tenantId === TENANT_A
	);
	check('another domain: magic link', (await route('ada@elsewhere.example')).kind === 'magic-link');
	check(
		'a subdomain is not the domain',
		(await route('ada@mail.example.com')).kind === 'magic-link'
	);
	check('not an address: magic link', (await route('example.com')).kind === 'magic-link');
	check('none of that needed a lookup', dns.state.calls === 0);

	await entitle('o1', NOW + DAY);
	check(
		'an expired entitlement: magic link',
		(await route('ada@example.com')).kind === 'magic-link'
	);
	await entitle('o1');

	await db.prepare(`UPDATE org_domains SET sso_enforced = 1 WHERE org_id = 'o1'`).run();
	await removeIdentityConnection(db, 'o1');
	const refused = await route('ada@example.com');
	check(
		'enforced with the connection removed: refused',
		refused.kind === 'refused' && refused.reason === 'sso-not-connected'
	);
	await setIdentityConnection(db, { orgId: 'o1', tenantId: TENANT_A, userId: 'u1', now: NOW });

	const lapsed = await resolveSignInRoute(
		db,
		'ada@example.com',
		NOW + 9 * DAY,
		resolver({ 'example.com': [] }).fetchFn
	);
	check('a lapsed domain: magic link, even enforced', lapsed.kind === 'magic-link');
	const challenge = (await listOrgDomains(db, 'o1'))[0].challenge;
	await verify('o1', 'example.com', challenge, NOW + 9 * DAY);
}

console.log('\nAccepting a provider sign-in (4)');
{
	const connection = (await getIdentityConnection(db, 'o1')) as IdentityConnection;
	const claims = { sub: 's1', tid: TENANT_A, name: 'Ada', email: 'Ada@Example.com' };
	const verifiedDomains = ['example.com'];
	const decide = (c: object, domains = verifiedDomains) =>
		allowSsoSignIn({ claims: c, connection, verifiedDomains: domains });
	const reason = (d: ReturnType<typeof allowSsoSignIn>) => (d.ok ? 'ok' : d.reason);

	const ok = decide(claims);
	check(
		'the connected tenant and a verified domain: accepted, lowercased',
		ok.ok && ok.email === 'ada@example.com'
	);
	check('the tenant claim may be uppercase', decide({ ...claims, tid: TENANT_A.toUpperCase() }).ok);
	check('another tenant: refused', reason(decide({ ...claims, tid: TENANT_B })) === 'wrong-tenant');
	check(
		'no tenant claim: refused',
		reason(decide({ ...claims, tid: undefined })) === 'wrong-tenant'
	);
	check(
		'a non-string tenant claim: refused',
		reason(decide({ ...claims, tid: [TENANT_A] })) === 'wrong-tenant'
	);
	check(
		'an address at another domain: refused',
		reason(decide({ ...claims, email: 'ada@elsewhere.example' })) === 'domain-not-verified'
	);
	check(
		'a subdomain address: refused',
		reason(decide({ ...claims, email: 'ada@mail.example.com' })) === 'domain-not-verified'
	);
	check(
		'a lookalike address: refused',
		reason(decide({ ...claims, email: 'ada@example.com@elsewhere.example' })) !== 'ok'
	);
	check('no verified domains: refused', reason(decide(claims, [])) === 'domain-not-verified');
	check(
		'no address claims: refused',
		reason(decide({ sub: 's1', tid: TENANT_A })) === 'no-address'
	);
	check(
		'the wrong tenant is refused before the address is read',
		reason(decide({ sub: 's1', tid: TENANT_B })) === 'wrong-tenant'
	);

	check(
		'the username is used when there is no email claim',
		entraAddress({ preferred_username: 'Ada@Example.com' }) === 'ada@example.com'
	);
	check(
		'the email claim wins over the username',
		entraAddress({ email: 'a@example.com', preferred_username: 'b@example.com' }) ===
			'a@example.com'
	);
	check(
		'a username that is not an address is not one',
		entraAddress({ preferred_username: 'ada' }) === null
	);
	check(
		'an unusable email claim falls back to the username',
		entraAddress({ email: 42, preferred_username: 'b@example.com' }) === 'b@example.com'
	);
	const viaUsername = decide({
		sub: 's1',
		tid: TENANT_A,
		preferred_username: 'ada@elsewhere.example'
	});
	check('a username at another domain: refused', reason(viaUsername) === 'domain-not-verified');

	check('against the database: accepted', (await checkSsoSignIn(db, claims, connection)).ok);
	const other = await claimDomain(db, {
		orgId: 'o1',
		domain: 'pending.example',
		userId: 'u1',
		now: NOW
	});
	check(
		'a claimed but unverified domain: refused',
		!!other &&
			reason(await checkSsoSignIn(db, { ...claims, email: 'ada@pending.example' }, connection)) ===
				'domain-not-verified'
	);
	const theirs = await claimDomain(db, {
		orgId: 'o3',
		domain: 'theirs.example',
		userId: 'u3',
		now: NOW
	});
	await verify('o3', 'theirs.example', theirs!.challenge);
	check(
		"another org's verified domain: refused",
		reason(await checkSsoSignIn(db, { ...claims, email: 'ada@theirs.example' }, connection)) ===
			'domain-not-verified'
	);
	await removeDomain(db, 'o1', 'pending.example');
	check('a removed claim is gone', (await listOrgDomains(db, 'o1')).length === 1);
}

console.log('\nThe provider (5)');
{
	const profile = entraProfile({ sub: 's1', name: ' Ada ', preferred_username: 'Ada@Example.com' });
	check(
		'the user is keyed on sub, with no image',
		profile.id === 's1' &&
			profile.image === null &&
			profile.name === 'Ada' &&
			profile.email === 'ada@example.com'
	);
	check('a user with no address has a null email', entraProfile({ sub: 's1' }).email === null);
	let threw = false;
	try {
		entraProfile({ email: 'ada@example.com' });
	} catch {
		threw = true;
	}
	check('claims with no sub are refused', threw);

	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		calls.push(String(input));
		return new Response('', { status: 404 });
	}) as typeof fetch;
	try {
		const provider = entraProvider({
			clientId: 'client',
			clientSecret: 'secret',
			tenantId: TENANT_A.toUpperCase()
		});
		const options = provider.options as {
			issuer?: string;
			allowDangerousEmailAccountLinking?: boolean;
			authorization?: { params?: { scope?: string } };
			profile?: (claims: object, tokens: object) => unknown;
		};
		check(
			'the issuer is the one tenant',
			options.issuer === `https://login.microsoftonline.com/${TENANT_A}/v2.0`
		);
		check(
			'the scope asks for no Graph access',
			options.authorization?.params?.scope === ENTRA_SCOPE && !ENTRA_SCOPE.includes('User.Read')
		);
		check(
			'existing accounts link on first sign-in',
			options.allowDangerousEmailAccountLinking === true
		);
		const user = (await options.profile?.(
			{ sub: 's1', email: 'Ada@Example.com' },
			{ access_token: 't' }
		)) as { email: string; image: null } | undefined;
		check(
			'the profile is ours and fetches nothing',
			user?.email === 'ada@example.com' && user.image === null && calls.length === 0
		);
	} finally {
		globalThis.fetch = realFetch;
	}
	for (const bad of ['common', 'organizations', ''])
		check(
			`no provider for ${JSON.stringify(bad)}`,
			(() => {
				try {
					entraProvider({ clientId: 'c', clientSecret: 's', tenantId: bad });
					return false;
				} catch {
					return true;
				}
			})()
		);
}

done();
