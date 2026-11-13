// A key pair for backups of the brains a deployment holds (src/lib/brain-backup.ts).
//
//   pnpm backup:keygen <private-key-file>
//
// Writes the private key to the file, readable by its owner only, and prints the public
// key for BACKUP_PUBLIC_KEY. The private key opens every backup sealed to this pair and
// is needed only to restore one: keep it off the deployment and out of any repository.

import { existsSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBackupKeys } from '../src/lib/brain-backup.ts';

const [file] = process.argv.slice(2);
if (!file) {
	console.error('usage: pnpm backup:keygen <private-key-file>');
	process.exit(1);
}
const target = resolve(file);
const root = fileURLToPath(new URL('..', import.meta.url));
if (!relative(root, target).startsWith('..')) {
	console.error('Write the private key outside this repository.');
	process.exit(1);
}
if (existsSync(target)) {
	console.error(`${target} exists. A new key cannot open backups sealed to the old one.`);
	process.exit(1);
}

const keys = await generateBackupKeys();
writeFileSync(target, keys.privateKey + '\n', { mode: 0o600 });
console.log(`Private key written to ${target}. Without it no backup can be restored.\n`);
console.log('Public key, for the deployment:\n');
console.log(`  gh variable set BACKUP_PUBLIC_KEY --body '${keys.publicKey}'\n`);
console.log('or BACKUP_PUBLIC_KEY in .dev.vars.');
