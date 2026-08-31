refactor(tests): six batteries share localD1 instead of copying the shim

src/local/d1-sqlite.ts already existed to be the one D1-over-node:sqlite shim,
and its header already said so. Six batteries carried their own copy anyway:
test-access, test-invites, test-links, test-scope, test-search and test-usage.
They now call localD1().

This is a correctness fix, not only de-duplication. Three of the copies
(test-invites, test-links, test-search) implemented `batch` as a plain loop over
the statements, with no transaction. D1 batches ARE transactional, and
writeThroughIndex depends on that: page rows and the freshness marker commit or
roll back together. localD1's batch wraps BEGIN/COMMIT/ROLLBACK, so those three
now assert against the semantics production has rather than a weaker one that
cannot fail the way the real thing does.

test-usage additionally built its table by naming migrations/0006 by filename,
which pins it to the migration that created usage_daily and silently misses any
later alteration. It applies the whole directory now, the same fix the other
authorization-adjacent batteries already got.

test-index.ts deliberately KEEPS its own copy, and already says why: it
instruments the shim to count statements and batches and to inject a failure
mid-batch, which is that battery's whole subject. A shared shim carrying those
hooks would be worse than the duplicate.

The "kept local so each golden test runs as one self-contained file" note in
test-scope.ts is replaced rather than deleted. That reasoning had a cost this
branch already paid: the copies drifted, and the one missing `meta.changes` made
the write-dedupe ledger answer a fresh write as already in flight. A battery is
still self-contained in what it ASSERTS; the D1 surface underneath it is not the
part worth re-deriving per file.

Verified the batteries genuinely depend on the shared shim rather than passing
regardless: removing `meta.changes` from localD1 turns test:scope red on six
checks, and restoring it turns them green. Plus pnpm typecheck, all 27 offline
batteries, and no gen:app or gen:templates drift.
