---
name: new-migration
description: Add a D1 schema migration under migrations/. Use for any change to the platform database's tables, columns, or indexes.
argument-hint: "<kebab-case-name> <what it changes>"
---

# Add a D1 migration

Migration: $ARGUMENTS

Runbook: `docs/ops/d1-migrations.md`. Production applies migrations in `deploy.yml`, before
the new code ships. Nobody applies one to a remote database by hand; the PreToolUse hook
refuses `d1 migrations apply --remote` and `d1 execute --remote`.

## 1. Keep it additive

A rollback reverts code, never schema, so the previous version must run against the new
schema at any moment.

- New tables, new nullable columns, new indexes: fine.
- A rename or a drop is two changes: expand (add the new shape, write both), deploy, then
  contract in a later migration once nothing reads the old shape.
- Never edit a migration that is already committed; the hook refuses that too. Add a new one.

## 2. Estimate the rows it writes

D1 bills and limits on rows written. A backfill `UPDATE` or an index over a large table
writes every row it touches. Count the affected rows (`SELECT COUNT(*)` against a local copy,
or reason from the table's size) and say the number in the pull request. A large backfill
belongs in a budgeted, resumable pass in code, not in a migration.

## 3. Create and apply locally

```sh
pnpm db:migrate:new <name>     # creates migrations/NNNN_<name>.sql
pnpm db:migrate                # apply to the LOCAL database
pnpm db:migrate:list           # confirm it applied
```

`src/db/*.sql` are reference copies; update the matching one so it still reads true.

## 4. Test

The battery that owns the tables runs the real migrations over `node:sqlite` (see
`scripts/test-access.ts` or `scripts/test-usage.ts` for the pattern). Extend it so the new
column or table is exercised by a query the code actually runs. CI also applies every
migration to a fresh local database.

## 5. Verify

```sh
pnpm db:migrate && pnpm typecheck && pnpm test
```
