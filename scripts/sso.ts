// pnpm sso: set up directory sign-in for one org: claim and verify a domain, connect a
// Microsoft Entra tenant (docs/design/enterprise-identity.md).
//
// The org also needs the `enterprise` entitlement (`pnpm entitle`), and the deployment needs
// AUTH_ENTRA_CLIENT_ID and AUTH_ENTRA_CLIENT_SECRET. Default is a DRY RUN that prints the
// SQL; nothing touches D1 until --apply.
//
// Usage:
//   pnpm sso --org <org_id> --claim example.com     [--apply local|remote|both]
//   pnpm sso --org <org_id> --verify example.com    [--apply ...]   reads the TXT record now
//   pnpm sso --org <org_id> --connect <tenant id>   [--apply ...]
//   pnpm sso --org <org_id> --remove-domain example.com | --disconnect   [--apply ...]

import { spawnSync } from 'node:child_process';
import {
	DOMAIN_TXT_PREFIX,
	lookupTxt,
	newChallenge,
	txtRecordValue
} from '../src/lib/org-domains.ts';
import { ssoSql, type SsoOp } from './sso-sql.ts';

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

const orgId = arg('org') ?? fail('--org <org_id> is required.');
const apply = arg('apply');
if (apply && !['local', 'remote', 'both'].includes(apply))
	fail('--apply is local, remote or both.');

const now = Date.now();
let op: SsoOp;
let after = '';
if (arg('claim')) {
	const challenge = newChallenge();
	op = { kind: 'claim', orgId, domain: arg('claim')!, challenge, now };
	after =
		`Add this TXT record to ${arg('claim')}, then run --verify:\n  ${txtRecordValue(challenge)}\n` +
		'A dry run prints a challenge that is not stored: add the record only after --apply.';
} else if (arg('verify')) {
	const domain = arg('verify')!;
	const values = await lookupTxt(domain);
	if (!values) fail(`The TXT lookup for ${domain} failed. Try again.`);
	const published = values
		.filter((v) => v.startsWith(DOMAIN_TXT_PREFIX))
		.map((v) => v.slice(DOMAIN_TXT_PREFIX.length));
	if (!published.length)
		fail(`${domain} has no TXT record starting with ${DOMAIN_TXT_PREFIX}. DNS can take a while.`);
	op = { kind: 'verify', orgId, domain, published, now };
	after =
		'The domain is verified only if the published challenge is the one stored for this org:' +
		' check that the statement changed one row.';
} else if (arg('remove-domain')) {
	op = { kind: 'remove-domain', orgId, domain: arg('remove-domain')! };
} else if (arg('connect')) {
	op = { kind: 'connect', orgId, tenantId: arg('connect')!, now };
} else if (process.argv.includes('--disconnect')) {
	op = { kind: 'disconnect', orgId };
} else {
	fail('One of --claim, --verify, --connect, --remove-domain or --disconnect is required.');
}

let sql: string;
try {
	sql = ssoSql(op);
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
if (after) console.log(`\n${after}`);
