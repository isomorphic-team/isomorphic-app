-- 0007_write_attempts: a short-lived ledger making a retried write safe.
--
-- WHY THIS EXISTS. Issue #50: a write that fails with a 502 (or a timeout, or a
-- dropped connection) leaves the caller unable to tell whether the commit
-- landed, and both ways of guessing wrong are silent. A retried `append`
-- duplicates the text; a retried `mode: "create"` fails claiming the page
-- exists, on a page the caller believes it never created. The only recourse was
-- reading the page before every retry, which is guidance rather than a
-- mechanism.
--
-- WHY IT IS KEYED ON THE CALL AND NOT ON THE COMMIT. An append's bundle is not
-- stable across a retry: attempt 1 reads body B and commits B+T; if that lands,
-- attempt 2 reads B+T and commits B+T+T. Fingerprinting the commit would miss
-- exactly the case this exists for. `fingerprint` is a hash of the ARGUMENTS the
-- caller passed (see src/lib/write-dedupe.ts), which are identical across both
-- attempts.
--
-- WHY ROWS ARE RESERVED BEFORE THE COMMIT. The client gives up long before the
-- Worker does, so a retry can arrive while the original is still committing. A
-- row written only on success would let that retry commit a second time.
--
-- WHY NOTHING LIVES HERE FOR LONG. A row speaks for a retry window, not for
-- history: completed rows are replayed for DONE_TTL_MS and unfinished ones for
-- IN_FLIGHT_GRACE_MS, and both are pruned by the next claim on the same brain,
-- so the table needs no separate job and stays bounded by write concurrency
-- rather than by write volume. It is a cache of "did this just happen", never a
-- record of what a person did: `view_activity` is the repo history, and the
-- Analytics tab is the usage record.
--
-- Additive: nothing deployed today reads or writes these rows, so the running
-- code is unaffected during the deploy window.

CREATE TABLE IF NOT EXISTS write_attempts (
  brain_id     TEXT NOT NULL,
  -- SHA-256 of (actor, tool, canonicalized arguments). The resolved brain is in
  -- brain_id, so the routing argument itself is excluded from the hash and a
  -- retry that spells the brain differently still matches.
  fingerprint  TEXT NOT NULL,
  -- 'in_flight' while the attempt is running, 'done' once it committed.
  state        TEXT NOT NULL,
  started_at   INTEGER NOT NULL,       -- epoch ms
  completed_at INTEGER,                -- epoch ms, NULL while in flight
  -- What the original attempt reported, replayed verbatim to the retry rather
  -- than recomputed: the retry asks the same question and deserves the same
  -- answer, including which paths were touched. The tools speak in wiki terms,
  -- never git terms, so the commit sha is deliberately not kept here.
  summary      TEXT,
  PRIMARY KEY (brain_id, fingerprint)
);

-- Pruning is "everything older than a cutoff", across brains, on every claim.
CREATE INDEX IF NOT EXISTS write_attempts_started_idx ON write_attempts (started_at);
