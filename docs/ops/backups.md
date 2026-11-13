# Backups of brains the deployment holds

A brain on GitHub is a git repository, and every clone is a copy. A brain the deployment
holds itself (`storage: "isomorphic"`) lives in one Durable Object, and this is its copy
outside that object: its files, sealed to a public key, in an R2 bucket.

Code: `src/lib/brain-backup.ts`, the alarm on `BrainFilesObject` (`src/objects/worker.ts`),
`scripts/backup-keygen.ts`, `scripts/backup-restore.ts`. Tests: `pnpm test:store` (the
backup and restore logic), `pnpm test:objects` (the alarm and the bucket, in workerd).

## What a backup is

- **When.** A brain's object sets an alarm when the brain changes. The backup runs ten
  minutes after the change, and no sooner than `BACKUP_INTERVAL_HOURS` (24) after the
  previous one. A brain that has not changed is not backed up again.
- **What.** Every file of one revision, text and attachments. Not the history: old
  versions and the commit log stay in the object. Not the platform database: orgs,
  members and sharing are D1 rows.
- **Where.** Under `brains/<brain-id>/` in the bucket:
  `<time>-r<revision>/part-00001` and up, then `manifest.json`, and `latest.json`, a copy
  of the newest manifest. A folder with no manifest is a backup that did not finish.
- **Kept.** The newest 14 per brain. Older ones are deleted when a backup finishes. Do not
  add a lifecycle rule that deletes by age: a brain nobody edits keeps one old backup, and
  an age rule would delete it.
- **Sealed.** Each part is encrypted with a key of its own (AES-256-GCM), wrapped to the
  deployment's public key (RSA-OAEP, 3072 bits). The deployment holds only the public key,
  so it can write a backup and cannot read one, and neither can anyone browsing the bucket.
  The manifests are plain JSON: brain id, revision, time, and counts of parts, files and
  bytes. They name no file.

**Lose the private key and every backup is unreadable.** Keep it somewhere that outlives
your laptop, such as a password manager. It is needed only to restore.

## Turning it on

```sh
pnpm exec wrangler r2 bucket create <bucket>
pnpm backup:keygen ~/somewhere-safe/isomorphic-backup.key   # prints the public key
gh variable set BACKUP_BUCKET --body <bucket>
gh variable set BACKUP_PUBLIC_KEY --body '<public key>'
```

Then deploy. For a deploy from your machine, put `BACKUP_BUCKET` and `BACKUP_PUBLIC_KEY`
in `.dev.vars` and run `pnpm setup:config --force` first. The deploy's API token needs
Workers R2 Storage edit, to bind the bucket.

Both settings are needed. With either empty, nothing is backed up and nothing warns you.
A brain gets its first backup after the first call that reaches it following the deploy,
if it has changed since its last backup or has none.

To confirm, list the bucket in the Cloudflare dashboard about ten minutes after editing a
held brain: `brains/<brain-id>/latest.json` should be there.

## Restoring

```sh
pnpm backup:restore --bucket <bucket> --brain <brain-id> \
  --key ~/somewhere-safe/isomorphic-backup.key --out ./restored
```

This reads the bucket through Wrangler, with your Wrangler login, and writes the brain's
files into `./restored`, which must be empty. `--backup <id>` opens an older backup (the
folder name in the bucket) and `--from <folder>` reads a folder holding the bucket's
objects under their keys.

The result is a folder of files. To look at it, `pnpm try ./restored`. To serve it as a
brain again, commit it to a new private repository and connect that with `connect_brain`;
`configure_brain` with `storage: "isomorphic"` then moves it back into the deployment.
Writing a backup over a brain that still exists is not built.

## Changing the key

Generate a new pair and set the new `BACKUP_PUBLIC_KEY`. Backups made before the change
open only with the old private key, so keep both until the old backups have been pruned.
