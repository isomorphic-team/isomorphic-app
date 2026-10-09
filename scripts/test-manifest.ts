// Golden test for the platform GitHub App manifest (src/manifest.ts).
//
//   pnpm test:manifest
//
// It exists to catch:
//   1. A widened App. The permissions are the platform's whole reach into every brain
//      repository it is installed on; they are pinned exactly, so adding one fails here.
//   2. An App registered under the wrong owner. With GITHUB_APP_ORG the manifest goes
//      to that organization's registration URL; a private App can only be installed on
//      its owner, so the personal-account URL there would leave it uninstallable.

import { buildManifest, manifestRegistrationUrl } from '../src/manifest.ts';

import { checker } from './check.ts';

const { check, done } = checker('manifest checks');

console.log('\nthe App declares exactly the permissions it needs');
{
	const m = buildManifest({ name: 'example-app', baseUrl: 'http://localhost:3000' });
	check(
		'permissions are exactly administration, contents, pull_requests write and metadata read',
		JSON.stringify(m.default_permissions) ===
			JSON.stringify({
				administration: 'write',
				contents: 'write',
				pull_requests: 'write',
				metadata: 'read'
			}),
		JSON.stringify(m.default_permissions)
	);
	check('it subscribes to no events', m.default_events.length === 0);
	check('it is private', m.public === false);
}

console.log('\nregistration goes to the owner the App will be installed on');
{
	check(
		'without an org, the personal-account URL',
		manifestRegistrationUrl('abc') === 'https://github.com/settings/apps/new?state=abc'
	);
	check(
		'a blank org is no org',
		manifestRegistrationUrl('abc', '  ') === 'https://github.com/settings/apps/new?state=abc'
	);
	check(
		'with an org, that organization’s URL',
		manifestRegistrationUrl('abc', 'example-org') ===
			'https://github.com/organizations/example-org/settings/apps/new?state=abc'
	);
	let threw = false;
	try {
		manifestRegistrationUrl('abc', 'example-org/../evil');
	} catch {
		threw = true;
	}
	check('a value that is not an org login is refused', threw);
}

done();
