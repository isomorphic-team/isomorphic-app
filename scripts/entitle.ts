// pnpm entitle — grant or revoke an enterprise feature for one org.
//
// The only writer of `org_entitlements` in this repository (billing, outside it, is the other).
// Default is a DRY RUN that prints the SQL; nothing touches D1 until --apply.
//
// Usage:
//   pnpm entitle --org <org_id> --feature review-models [--source plan|trial|manual]
//     [--expires 2027-01-01] [--cap 50] [--note "..."] [--apply local|remote|both]
//   pnpm entitle --org <org_id> --feature review-models --revoke [--apply ...]

import { spawnSync } from 'node:child_process';
import { entitlementSql, type EntitlementSource, type Feature } from '../ee/entitlements.ts';

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

const orgId = arg('org') ?? fail('--org <org_id> is required.');
const feature = (arg('feature') ?? fail('--feature is required (e.g. review-models).')) as Feature;
const apply = arg('apply');
if (apply && !['local', 'remote', 'both'].includes(apply))
	fail('--apply is local, remote or both.');

let sql: string;
try {
	if (process.argv.includes('--revoke')) {
		sql = entitlementSql({ kind: 'revoke', orgId, feature });
	} else {
		const expires = arg('expires');
		const cap = arg('cap');
		sql = entitlementSql({
			kind: 'grant',
			orgId,
			feature,
			source: (arg('source') ?? 'manual') as EntitlementSource,
			now: Date.now(),
			expiresAt: expires ? Date.parse(expires) : undefined,
			monthlyCapUsd: cap ? Number(cap) : undefined,
			note: arg('note')
		});
	}
} catch (e) {
	fail((e as Error).message);
}

console.log(sql);
if (!apply) {
	console.log('\nDry run. Pass --apply local|remote|both to write it.');
	process.exit(0);
}
for (const target of apply === 'both' ? ['local', 'remote'] : [apply]) {
	const res = spawnSync(
		'pnpm',
		['exec', 'wrangler', 'd1', 'execute', 'platform-db', `--${target}`, '--command', sql],
		{ stdio: 'inherit' }
	);
	if (res.status !== 0) fail(`wrangler d1 execute failed for ${target} D1 (exit ${res.status}).`);
}
