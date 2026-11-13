// Connecting a Google Drive (src/lib/drive-connection.ts) against a fake Google
// (scripts/fake-google-drive.ts) and the real migrations on node:sqlite. Offline.
//
//   pnpm test:drive
//
// What it exists to catch:
//   1. A CONSENT THAT ASKS FOR THE WRONG THING. The link asks for the drive.file scope
//      alone, offline, at the registered redirect address; a deployment without a client
//      has none; a grant without the Drive scope connects nothing.
//   2. A STORED TOKEN SOMEONE WITH THE DATABASE CAN USE. The refresh token and the cached
//      access token are stored sealed; a sealed value opens only with the deployment's
//      secret and only for the row it was sealed for.
//   3. A DRIVE REACHED BY THE WRONG PEOPLE. A connection belongs to one org and the person
//      who connected it: a colleague's is not offered, another org's is not offered, and
//      the same Google account connected to two orgs is two connections.
//   5. A LINK THAT CONNECTS SOMEONE ELSE'S DRIVE. The connect link works only in a browser
//      signed in as the person it was made for, once, within its hour; a callback without
//      a code, or replayed, connects nothing.
//   6. A DRIVE BRAIN THE WORKER CANNOT FIND. A brain created in a Drive is listed with its
//      connection's kind and its folder, which is what the Worker opens its store by; two
//      brains of one name get a folder each, under one home folder; a Drive is never a
//      default, and is refused where the deployment cannot reach one.
//   4. A TOKEN MINTED ON EVERY REQUEST, OR NEVER AGAIN. An access token is reused while
//      it lasts and minted from the refresh token otherwise; a grant Google no longer
//      honours says to connect again.

import { createBrainFolder, driveApi, driveBrainStore } from '../src/lib/brain-store-drive.ts';
import { createBrain, listAccessibleBrains } from '../src/lib/orgs.ts';
import {
	DRIVE_SCOPE,
	completeDriveConnect,
	credentialKey,
	driveAccount,
	driveAuthUrl,
	driveConnectionFor,
	driveConnectionId,
	driveTokenSource,
	exchangeCode,
	googleClient,
	openCredential,
	pendingDriveConnect,
	saveDriveConnection,
	sealCredential,
	startDriveConnect,
	type PendingStore,
	type TokenCache
} from '../src/lib/drive-connection.ts';
import {
	GOOGLE_DRIVE_KIND,
	chooseBrainStorage,
	credentialFor
} from '../src/lib/storage-connections.ts';
import { inMemoryWriteCoordinator } from '../src/lib/write-coordinator.ts';
import { localD1 } from '../src/local/d1-sqlite.ts';
import { checker, errorOf } from './check.ts';
import { fakeGoogleDrive } from './fake-google-drive.ts';

const { check, done } = checker('drive checks');

const env = {
	GOOGLE_CLIENT_ID: 'client-id',
	GOOGLE_CLIENT_SECRET: 'client-secret',
	PUBLIC_BASE_URL: 'https://brain.example/'
};
const client = googleClient(env)!;

// ---------- 1. the consent ----------
{
	console.log('\nconsent');
	check(
		'the redirect address is the callback on the public origin',
		client.redirectUri === 'https://brain.example/google/callback'
	);
	check(
		'a deployment missing the id, the secret or its origin has no client',
		!googleClient({ ...env, GOOGLE_CLIENT_ID: ' ' }) &&
			!googleClient({ ...env, GOOGLE_CLIENT_SECRET: undefined }) &&
			!googleClient({ ...env, PUBLIC_BASE_URL: '' })
	);
	const url = new URL(driveAuthUrl(client, 'state-1'));
	const q = url.searchParams;
	check(
		'the link asks Google for drive.file alone, offline, with consent',
		url.origin + url.pathname === 'https://accounts.google.com/o/oauth2/v2/auth' &&
			q.get('scope') === DRIVE_SCOPE &&
			DRIVE_SCOPE.endsWith('/auth/drive.file') &&
			q.get('access_type') === 'offline' &&
			q.get('prompt') === 'consent' &&
			q.get('response_type') === 'code'
	);
	check(
		'and carries the client, the redirect address and the state',
		q.get('client_id') === 'client-id' &&
			q.get('redirect_uri') === client.redirectUri &&
			q.get('state') === 'state-1' &&
			!url.href.includes('client-secret')
	);

	const google = fakeGoogleDrive();
	const grant = await exchangeCode(google.fetch, client, 'auth-code');
	const sent = google.tokenRequests[0];
	check(
		'the code is exchanged with the secret and the same redirect address',
		grant.refreshToken === 'refresh-1' &&
			sent.grant_type === 'authorization_code' &&
			sent.client_secret === 'client-secret' &&
			sent.redirect_uri === client.redirectUri
	);
	const account = await driveAccount(google.fetch, grant.accessToken);
	check(
		'the account is the one the token belongs to',
		account.id === 'perm-1' && account.email === 'person@drive.example'
	);
	google.grantsScope = false;
	const unticked = await errorOf(() => exchangeCode(google.fetch, client, 'auth-code'));
	check(
		'a grant without the Drive scope connects nothing',
		!!unticked && /was not granted/.test(unticked),
		String(unticked)
	);
	const badCode = await errorOf(() => exchangeCode(google.fetch, client, 'stale'));
	check('a code Google refuses is an error', !!badCode, String(badCode));
	const wrongSecret = await errorOf(() =>
		exchangeCode(google.fetch, { ...client, clientSecret: 'nope' }, 'auth-code')
	);
	check(
		"a refused request reports Google's error code and not the request",
		!!wrongSecret && /invalid_client/.test(wrongSecret) && !wrongSecret.includes('nope'),
		String(wrongSecret)
	);
}

// ---------- 2. sealing ----------
const key = await credentialKey('deployment-secret');
{
	console.log('\nsealing');
	const sealed = await sealCredential(key, 'refresh-token-value', 'row-a');
	check(
		'a sealed credential does not hold the secret',
		!sealed.includes('refresh-token-value') && !atob(sealed.split('.')[2]).includes('refresh')
	);
	check(
		'it opens with the key, for its row',
		(await openCredential(key, sealed, 'row-a')) === 'refresh-token-value'
	);
	check(
		'it does not open for another row',
		!!(await errorOf(() => openCredential(key, sealed, 'row-b')))
	);
	const other = await credentialKey('another-secret');
	check(
		"it does not open under another deployment's secret",
		!!(await errorOf(() => openCredential(other, sealed, 'row-a')))
	);
	check(
		'sealing twice gives two ciphertexts',
		sealed !== (await sealCredential(key, 'refresh-token-value', 'row-a'))
	);
	check('a deployment without a secret cannot seal', !!(await errorOf(() => credentialKey(''))));
}

// ---------- 3. the connection, and who it is offered to ----------
const { db, sqlite } = localD1();
sqlite.exec(`
	INSERT INTO app_users (user_id, email) VALUES ('ann', 'ann@example.com'), ('bo', 'bo@example.com');
	INSERT INTO orgs (org_id, name, model, installation_id, brain_owner, created_by, created_at)
		VALUES ('o1', 'Acme', 'hosted', 7, 'example-org', 'ann', '2026-01-01'),
		       ('o2', 'Northwind', 'hosted', 7, 'example-org', 'ann', '2026-01-02');
`);
const account = { id: 'perm-1', email: 'person@drive.example' };
const google = fakeGoogleDrive();
const grant = await exchangeCode(google.fetch, client, 'auth-code');
const connectionId = await saveDriveConnection(db, key, {
	orgId: 'o1',
	userId: 'ann',
	account,
	refreshToken: grant.refreshToken
});
{
	console.log('\nconnection');
	const row = sqlite
		.prepare(`SELECT * FROM storage_connections WHERE connection_id = ?`)
		.get(connectionId) as Record<string, unknown>;
	check(
		'a connection is a Google Drive the org owns, named by the account',
		connectionId === driveConnectionId('o1', 'perm-1') &&
			row.kind === GOOGLE_DRIVE_KIND &&
			row.provider === 'google' &&
			row.owner_org_id === 'o1' &&
			row.account === 'person@drive.example'
	);
	const stored = () =>
		sqlite.prepare(`SELECT * FROM storage_credentials ORDER BY connection_id`).all() as {
			connection_id: string;
			sealed: string;
			connected_by: string;
		}[];
	check(
		'the refresh token is stored sealed',
		stored().length === 1 &&
			!JSON.stringify(stored()).includes(grant.refreshToken) &&
			(await openCredential(key, stored()[0].sealed, connectionId)) === grant.refreshToken
	);

	const again = await exchangeCode(google.fetch, client, 'auth-code');
	await saveDriveConnection(db, key, {
		orgId: 'o1',
		userId: 'ann',
		account,
		refreshToken: again.refreshToken
	});
	check(
		'connecting the same account again replaces the token',
		stored().length === 1 &&
			(await openCredential(key, stored()[0].sealed, connectionId)) === again.refreshToken
	);
	const elsewhere = await saveDriveConnection(db, key, {
		orgId: 'o2',
		userId: 'ann',
		account,
		refreshToken: again.refreshToken
	});
	check(
		'the same account connected to another org is another connection',
		elsewhere !== connectionId && stored().length === 2
	);
	check(
		'a sealed token does not open for the other connection',
		!!(await errorOf(() => openCredential(key, stored()[0].sealed, elsewhere)))
	);

	check(
		'a person is offered the Drive they connected, through any of their accounts',
		(await driveConnectionFor(db, 'o1', ['ann']))?.connection_id === connectionId &&
			(await driveConnectionFor(db, 'o1', ['other', 'ann']))?.connection_id === connectionId
	);
	check(
		"a colleague is not offered it, and nobody is offered another org's",
		(await driveConnectionFor(db, 'o1', ['bo'])) === null &&
			(await driveConnectionFor(db, 'o1', [])) === null &&
			(await driveConnectionFor(db, 'o2', ['ann']))?.connection_id === elsewhere
	);
}

// ---------- 4. access tokens ----------
{
	console.log('\naccess tokens');
	const kv = new Map<string, string>();
	const ttls: number[] = [];
	const cache: TokenCache = {
		get: async (k) => kv.get(k) ?? null,
		put: async (k, v, o) => {
			kv.set(k, v);
			ttls.push(o.expirationTtl);
		}
	};
	const source = (id = connectionId, k = key) =>
		driveTokenSource({ db, cache, key: k, client, connectionId: id, fetcher: google.fetch });
	google.tokenRequests.length = 0;

	const first = source();
	check('a token is minted from the stored refresh token', (await first()) === 'test-token');
	check(
		'by a refresh grant',
		google.tokenRequests.length === 1 && google.tokenRequests[0].grant_type === 'refresh_token'
	);
	await first();
	await source()();
	check('and reused, within a request and by the next one', google.tokenRequests.length === 1);
	check(
		'the cached token is sealed, and expires before Google expires it',
		kv.size === 1 && ![...kv.values()][0].includes('test-token') && ttls[0] < 3599 && ttls[0] > 3000
	);

	// A cache entry this deployment's secret does not open is passed over.
	const other = await credentialKey('another-secret');
	kv.set([...kv.keys()][0], await sealCredential(other, 'old', [...kv.keys()][0]));
	check(
		'an unreadable cached token is minted again',
		(await source()()) === 'test-token' && google.tokenRequests.length === 2
	);

	// The store, reading Drive with a token it got this way.
	kv.clear();
	const store = driveBrainStore(
		driveApi(google.fetch, source()),
		{ folderId: google.rootId },
		inMemoryWriteCoordinator(),
		'brain-1'
	);
	await store.write(
		{ owner: 'example-org', repo: 'brain' },
		{
			message: 'Add',
			writes: [{ path: 'wiki/a.md', content: '# A\n' }]
		}
	);
	check(
		'the Drive store writes with a token from the connection',
		google.tree()['wiki/a.md'] === '# A\n'
	);

	kv.clear();
	google.refreshTokens.clear();
	const revoked = await errorOf(() => source()());
	check(
		'a grant Google no longer honours says to connect again',
		!!revoked && /Connect the Google Drive again/.test(revoked),
		String(revoked)
	);
	const missing = await errorOf(() => source('google-drive:o1:nobody')());
	check(
		'so does a connection with no stored credential',
		!!missing && /Connect the Google Drive again/.test(missing)
	);
	const rekeyed = await errorOf(() => source(connectionId, other)());
	check(
		'and one sealed under a secret the deployment no longer has',
		!!rekeyed && /Connect the Google Drive again/.test(rekeyed)
	);
}

// ---------- 5. the connect flow ----------
{
	console.log('\nconnect flow');
	const held = new Map<string, string>();
	const kv: PendingStore = {
		get: async (k) => held.get(k) ?? null,
		put: async (k, v) => void held.set(k, v),
		delete: async (k) => void held.delete(k)
	};
	const flow = fakeGoogleDrive();
	flow.account = { permissionId: 'perm-9', emailAddress: 'bo@drive.example' };
	const complete = (state: string | null, code: string | null, sessionUserIds: string[]) =>
		completeDriveConnect({ db, kv, key, client, fetcher: flow.fetch, state, code, sessionUserIds });
	const stateOf = (link: string) => new URL(link).searchParams.get('state');

	const link = await startDriveConnect(kv, 'https://brain.example/', { userId: 'bo', orgId: 'o1' });
	const state = stateOf(link);
	check(
		'the link is to this deployment, with a state and nothing else',
		link === `https://brain.example/google/connect?state=${state}` && !!state && state.length >= 32
	);
	const someoneElse = await pendingDriveConnect(kv, state, ['ann']);
	check(
		'a browser signed in as someone else is refused',
		'problem' in someoneElse && /different account/.test(someoneElse.problem)
	);
	check('and so is their callback', 'problem' in (await complete(state, 'auth-code', ['ann'])));
	check(
		'which leaves the link good for the person it was made for',
		!('problem' in (await pendingDriveConnect(kv, state, ['bo2', 'bo'])))
	);
	check(
		'an unknown or missing state is refused',
		'problem' in (await pendingDriveConnect(kv, 'nope', ['bo'])) &&
			'problem' in (await pendingDriveConnect(kv, null, ['bo']))
	);

	const connected = await complete(state, 'auth-code', ['bo']);
	check(
		'the callback records the Drive for that person and org',
		!('problem' in connected) &&
			connected.email === 'bo@drive.example' &&
			(await driveConnectionFor(db, 'o1', ['bo']))?.connection_id === connected.connectionId &&
			(await driveConnectionFor(db, 'o1', ['ann']))?.connection_id === connectionId
	);
	const replayed = await complete(state, 'auth-code', ['bo']);
	check(
		'a replayed callback connects nothing',
		'problem' in replayed && /expired or was already used/.test(replayed.problem)
	);

	const declined = await startDriveConnect(kv, 'https://brain.example', {
		userId: 'bo',
		orgId: 'o2'
	});
	const refused = await complete(stateOf(declined), null, ['bo']);
	check(
		'a callback without a code connects nothing, and spends the link',
		'problem' in refused &&
			/was not granted/.test(refused.problem) &&
			held.size === 0 &&
			(await driveConnectionFor(db, 'o2', ['bo'])) === null
	);
	const bad = await startDriveConnect(kv, 'https://brain.example', { userId: 'bo', orgId: 'o2' });
	const failed = await complete(stateOf(bad), 'stale-code', ['bo']);
	check(
		'a code Google refuses is reported, not thrown',
		'problem' in failed,
		JSON.stringify(failed)
	);
}

// ---------- 6. a brain in a Drive ----------
{
	console.log('\ndrive brains');
	const g = fakeGoogleDrive();
	const api = driveApi(g.fetch, async () => 'test-token');
	const a = await createBrainFolder(api, 'Team Wiki');
	const b = await createBrainFolder(api, 'Team Wiki');
	check(
		'each brain gets a folder of its own, under one home folder',
		a !== b &&
			JSON.stringify(g.folders()) ===
				JSON.stringify(['Isomorphic', 'Isomorphic/Team Wiki', 'Isomorphic/Team Wiki'])
	);

	sqlite.exec(`INSERT INTO memberships (org_id, user_id, role) VALUES ('o1', 'ann', 'owner')`);
	await createBrain(db, {
		brain_id: 'drive-brain',
		org_id: 'o1',
		repo_owner: 'example-org',
		repo_name: 'team-wiki',
		name: 'Team Wiki',
		visibility: 'org',
		storage_connection_id: connectionId,
		storage_root: a
	});
	const listed = (await listAccessibleBrains(db, ['ann'])).find(
		(x) => x.brain_id === 'drive-brain'
	);
	check(
		'a Drive brain is listed with its connection and its folder',
		listed?.storage_kind === GOOGLE_DRIVE_KIND &&
			listed.storage_root === a &&
			listed.storage_connection_id === connectionId
	);
	check(
		'and is opened as a Drive, not as a repository',
		!!listed && credentialFor(listed).kind === 'google-drive'
	);

	const choose = (o: Partial<Parameters<typeof chooseBrainStorage>[0]>) =>
		chooseBrainStorage({
			deploymentDefault: 'isomorphic',
			platformOwned: true,
			canHold: true,
			...o
		});
	check(
		'a Drive is chosen only when asked for',
		JSON.stringify(choose({ canDrive: true })) === '{"storage":"isomorphic"}' &&
			JSON.stringify(choose({ canDrive: true, requested: 'google-drive' })) ===
				'{"storage":"google-drive"}'
	);
	check(
		'and refused where the deployment cannot reach one',
		'problem' in choose({ requested: 'google-drive' }) &&
			'problem' in choose({ requested: 'google-drive', canDrive: false })
	);
}

done();
