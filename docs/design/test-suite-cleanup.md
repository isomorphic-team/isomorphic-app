# Test suite cleanup

- Status: proposed
- Related: [`.claude/rules/testing.md`](../../.claude/rules/testing.md),
  [`.claude/skills/add-battery/SKILL.md`](../../.claude/skills/add-battery/SKILL.md)

An audit of every offline battery (37 `scripts/test-*.ts` and `scripts/e2e-*.ts` files, about
17,500 lines) and the Playwright suite (`tests/ui/`, 135 tests), looking for duplicate,
redundant, and stale tests. Line numbers are against `main` at `1e9dc39`.

## Verdict

The suite is in better shape than its size suggests. Almost every battery uses the shared
`checker`, `localD1` runs the real migrations, the layer splits (pure function in a node
battery, mounted behavior in a browser spec) are deliberate and documented in each header, and
`test:wiring` keeps `package.json` and CI in sync. Outright duplicates are rare, and the
deletable cruft comes to roughly 4% of the lines.

The cruft that matters is not volume. It is in four places:

1. **Checks that cannot fail.** About a dozen assertions stay green through the regression
   their label names. One of them hides a real production defect.
2. **A CI gate that does not run.** The visual baselines are never compared in CI.
3. **Sleeps.** About 45 seconds of every `pnpm test` is fixed sleeps for GitHub replication lag,
   on a backend (fs + git) that has none.
4. **Copied harness code**, mostly between the two e2e batteries and two octokit stubs.

Everything else is small: redundant cases, misplaced sections, vague names, and headers and
comments that describe an older version of the code.

## Timing today

All 37 batteries pass on `main`. Measured on a quiet machine:

| Battery                 | Time  | Note                                                    |
| ----------------------- | ----- | ------------------------------------------------------- |
| `test:ui`               | 150s  | `bounds.spec` 121s, `web-nav.spec` 94s (worker time)    |
| `test:e2e-librarian`    | 40s   | at least 24s of it is `settledHead` sleeping            |
| `test:e2e-import`       | 24s   | 18s of it is twelve unconditional `sleep(1500)` calls   |
| the 34 other batteries  | ~22s  | 0.4 to 2.4s each, mostly `tsx` startup                  |

## Phase 0: defects the audit found (fix first, each its own PR)

**0.1 `brains` never takes its "already indexed" fast path.** `detectRowSetup` in
`src/tools/brains.ts` is called with `r.id` (line 329), the brain's handle slug, and passes it to
`hasIndexedPages`, which queries `brain_pages WHERE brain_id = ?`. Since migration 0011 the index
is keyed by the primary `brain_id` (`brainRefs` in `src/lib/orgs.ts`). So the lookup never matches
in production, and every `brains` call resolves a full context for every brain the caller
manages. `scripts/test-scope.ts:536-556` passes because its fixture inserts `brain_pages` under
the handle (`northwind/main`), the same wrong key. Fix: carry `brain_id` on the row (or look it up)
and pass that; change the fixture to key by `b-main`; break it to confirm the test goes red.
Cost, not correctness, but it is the cost the code comment says is gone.

**0.2 Visual baselines never gate CI.** The `ui` job runs in the Linux Playwright container.
`tests/ui/__screenshots__/` holds only `darwin/`, so `scripts/test-ui.ts:72-82` drops the
`visual` project with a warning. That branch ignores `UI_STRICT`, so CI is green while comparing no
screenshots, and the header's "Set UI_STRICT=1 to turn both skips into failures" is false. The
`ui-baselines` skill also describes Linux baselines that do not exist. Decide one of:

- (recommended) generate `linux/` baselines with the documented container command, commit them,
  and make a missing-baseline skip fail under `UI_STRICT`; or
- declare visual local-only and correct the three documents (`scripts/test-ui.ts` header,
  `.claude/rules/testing.md`, the `ui-baselines` skill).

**0.3 CI's "generated artifacts in sync" step misses a file.** `gen:app` also writes
`app/views/registry.generated.ts` (`scripts/gen-app.ts:31`), but `.github/workflows/ci.yml:91-97`
diffs only the bundle and the template module. Add it to both lists.

## Phase 1: checks that cannot fail

Each of these needs a real assertion, and each fix is proven by breaking the code and watching it
go red.

| Where                                    | Problem                                                                                                                                     | Fix                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `scripts/roundtrip-check.ts:54-58`       | passes if byte-stable OR semantically stable. `- a` vs `* a` and `[[X]]` vs `\[\[X\]\]` are semantically equal, so the two regressions it guards (bullet style, escaped wikilinks) pass | give each fixture an expected mode; require byte stability except the table and emphasis fixtures |
| `scripts/test-tools.ts:126`              | "reserved brain input" fixture has no body, so it fails as "empty tool". The reserved-name branch is untested. All `err:` cases assert only `!!error` | give it a body; match each error's message                                                  |
| `scripts/test-tools.ts:160`              | "brain arg is optional" parses `{project}`; zod strips unknown keys, so it passes without `brain` in the shape                             | assert `brain` is in the shape and optional                                                 |
| `scripts/test-usage.ts:458-461`          | "another org's rows are never returned" checks `calls <= 4`; a leaked row has `calls === 1`                                                  | assert the leaked day/org row is absent, or the row count                                   |
| `scripts/test-invites.ts:328-331`        | "invite is marked accepted" reads `listPendingInvites`, which never lists brain invites                                                      | read `listPendingBrainInvites`                                                              |
| `scripts/test-invites.ts:272-281`        | expired and accepted filters exercised in one call; either check passes for the other                                                       | split into two calls, drop the re-read                                                      |
| `scripts/test-index.ts:333, 381, 412`    | `check('converged ...', true)`; non-convergence throws before it                                                                            | assert a read bound (`reads <= N`) or log instead                                           |
| `scripts/test-search.ts:629-640`         | "the two ways of deriving a page signal agree" never builds the SQL-side signal                                                              | export the row-to-signal mapping and compare, or delete                                     |
| `scripts/test-search.ts:453-460`         | builds `path:line: text` itself and parses its own string                                                                                    | delete; `e2e-librarian` pins the real format                                                |
| `scripts/test-access.ts:216-219`         | "off by default" passes `readOnly: false` explicitly                                                                                         | drop the argument                                                                           |
| `scripts/test-policy.ts:523-527`         | expected value recomputed from `COMFORTABLE`, so it restates the rule                                                                        | assert the literal outcome                                                                  |
| `scripts/test-feedback.ts:46`            | `!out.includes('ABC')` is vacuous for the JWT fixture                                                                                        | assert a distinctive substring of each input is gone                                        |
| `scripts/test-loading.ts:202`            | `hashSeed(x) === hashSeed(x)` in one process, labelled "stable across runs"                                                                 | delete; 195-197 cover determinism                                                           |
| `tests/ui/editor.spec.ts:73-81`          | "same page renders its view live" opens `vision.md`, which has no view, so the negative cannot fail                                         | open `wiki/orgs/acme-health.md` and assert the rendered view                                |
| `tests/ui/web-nav.spec.ts:208, 229`      | locators `'..., body'` and `'svg, canvas'` match at once                                                                                     | wait on `main[data-view="search"]` and the graph canvas                                     |
| `scripts/test-probe.ts:196-206`          | `dropped first \|\| rankLast` where the first branch is always true                                                                          | assert `rankLast` alone                                                                     |

## Phase 2: time

- **Gate the e2e sleeps on `GITHUB_MODE`.** `settledHead` in `scripts/e2e-librarian.ts:289-299`
  sleeps at least 1.2s on each of about 20 calls; `scripts/e2e-import.ts` calls `sleep(1500)` twelve
  times unconditionally. The fs store commits synchronously. Offline, `settledHead` returns
  `headSha()` and `sleep` is a no-op. Saves about 40s per CI run. `e2e-librarian.ts:692-693` also
  sleeps to compute a `before` that is never read: either assert on it (see Phase 4) or delete it.
- **Trim the UI sweeps.** `tests/ui/smoke.spec.ts:10-21` and the rail sweep in
  `tests/ui/bounds.spec.ts:240-276` both boot every route; bounds does it in three modes (about 45
  boots, 89s). Run bounds in inline plus one window mode, and have its inline pass assert the
  mounted view and no page error, so smoke's sweep and its "never falls through to the error view"
  and "cold boot" cases fold in. Merge smoke's two slow-result tests, which open the same route and
  each wait 2.5s. Estimated 30 to 50s of worker time.
- **Investigate why a two-load web-nav test costs about 15s** against about 2s in the harness
  before optimizing it.

## Phase 3: shared harness

| Copies                                                                                     | Extract                                                                                                                          | Est. lines |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `e2e-import.ts:33-159` and `e2e-librarian.ts:56-260`: `.dev.vars` parser, scratch brain on both backends, retried `rm`, in-memory client, `call`/`callSc`, `headSha`, `sleep` | one `scripts/e2e-harness.ts` (scratch brain, client, `call`, `eventually`); read `.dev.vars` through `readDevVars` in `src/persist.ts` | 70 to 90   |
| octokit stub in `test-index.ts:149-220` and its subset in `test-links.ts:43-75`            | one fake GitHub factory in `scripts/`                                                                                            | 30         |
| own `check` and failure counter in `test-render.ts`, `test-web.ts`, `roundtrip-check.ts`  | use `checker`                                                                                                                    | 25         |
| throw catchers: `threw`/`threwAsync` and four IIFEs in `test-access`, four blocks in `test-invites`, one in `test-email`, `throws` in `test-payloads` | add `throws`, `rejects`, `errorOf` to `scripts/check.ts`                                                                         | 40         |
| "migrated up to version N" replay, three times in `test-access` (1100, 1197, 1265) and a variant in `test-index` (1009) | one helper beside `applyMigrations` in `src/local/d1-sqlite.ts`                                                                  | 15         |
| hand-written D1 shim in `test-dedupe.ts:376-403` (its comment says it matches `test-usage` and `test-access`, which both moved to `localD1`) | `localD1()`                                                                                                                      | 22         |
| `memoryLedger` in `test-dedupe.ts:192-234` re-implements the ledger's SQL by hand          | run the `dedupeWrite` scenarios on `d1WriteLedger(localD1().db)`                                                                 | 35         |
| `registeredToolNames` copied into `test-usage.ts:68-73`, a subset in `test-web.ts:273-280` | import it from `scripts/doc-refs.ts`                                                                                             | 8          |
| two identical throwing proxies in `test-scope.ts:158-177`                                  | one `trap(name)` factory                                                                                                         | 8          |

Leave the D1 shim in `test-index.ts:41-91` (it counts statements and injects faults, and its
comment says why) and the per-battery org seed SQL (the personas differ on purpose).

## Phase 4: duplicate and redundant cases

Each was checked by reading both copies on the same code path. Delete unless noted.

- **e2e refusals that restate pure decisions.** `e2e-librarian.ts` re-asserts refusals already
  pinned on `checkPageWrite`, `planPageWrite` and `applyFieldPatch` in `test-page-patch.ts`
  (365-384, 690-702, 729-737, 1037-1046), plus type ordering and titling (538-556, 610-634). The
  e2e copies check only `isError` and a regex, while `write-path.md` says e2e proves "nothing was
  written". Keep one refusal per decider and make it assert the commit count is unchanged; keep
  704-727 and 1044-1058, which do check the file. Also drop 356-361 (it tests the SDK's zod enum)
  and one of the two URL-guard refusals at 1410-1421.
- `test-scope.ts:462-470, 473-478, 493-498` (org forwarding and the brains payload over a stubbed
  `listOrgs`): `e2e-librarian.ts:1610-1651, 1756-1771` assert the same outcome against the real
  queries. Keep the `requires` and lurker checks.
- `test-access.ts:125-130` (third copy of the grant-admin rule), `814-817` and `835-838`
  (subsumed by the composition checks at 895-905), `915-918` and `970-973` (each implied by the
  next check).
- `test-search.ts:595-602` (implied by 556), `test-links.ts:191-195` (implied by 190),
  `test-dedupe.ts:122-126` (implied by 118-121).
- `test-page-patch.ts:506-509` (same as 502-505); `284-295` is muddled: assert `note === ''` and
  drop the rest.
- `test-media.ts:301-305` (can only fail with 295), `558-568` (composition of two pinned checks).
- `test-web.ts:472` (repeated by 486-489), `69-73` and `314`.
- `test-usage.ts:186-189` (type-guaranteed), `208-209` (implied by 204-207).
- `test-loading.ts:166` (implied by the pattern check at 174-181).
- `tests/ui/web-nav.spec.ts:104-120` "following a link moves the address bar" is implied by the
  back/forward and copied-URL tests; fold its `.md`-suffix check into the latter.
- `test-scope.ts:911-916` runs the handler twice; reuse `read`.
- Smaller: `test-search.ts:98, 473-477, 504`; `test-record.ts:78-83` (keep one `.md` case);
  `test-app-resource.ts:105`; `e2e-import.ts:409-415` reduces to "adopted once, has
  `source_key`".

## Phase 5: placement and names

- **`test-access.ts` is three batteries.** Commit attribution (798-905) belongs with
  `test-record`; `platformInstall` (957-1030) with `test-invites`; the migration 0011 re-key
  (1260-1321) with `test-index`. That takes it from 1645 lines to about 1350 and makes its header
  true.
- **Link-graph sections live outside `test-links`.** Move `test-index.ts:446-564` (attachments in
  the graph) and `test-structure.ts:440-462` (`backlinksTo` aggregation) to `test-links`, beside the
  pure `classifyMdLink` cases.
- **Tool-surface checks live outside `test-annotations`.** Move `test-usage.ts:408-417` (no
  `execution` field) and `test-preamble.ts:176-212` (retry wording in write tool descriptions)
  there; drop the "no longer says only TIMES OUT" negative.
- `test-scope.ts:649-657` (`read_media` path refusals) to `test-media`.
- `tests/ui/navigation.spec.ts` "search is a PAGE" to `search.spec.ts`, reusing its helper.
- Regroup `e2e-librarian.ts:1060-1174` so the custom-tools section is contiguous.
- **Renames for a 1:1 script-to-file mapping:** `test:tools` to `test:custom-tools` (it tests only
  `src/lib/custom-tools.ts`), and align `test:appmeta`, `test:patch` (half the file is
  `page-write.ts`) and `test:roundtrip` with their files. Update `package.json`, `ci.yml` and the
  rules files that name them; `test:wiring` and `test:docs` catch what is missed.

## Phase 6: stale prose and coverage claims

Rules files that claim more than the tests pin (fix the test or the sentence):

- `.claude/rules/web-app.md` says `e2e-librarian` pins `webUrl` in both halves for every widget
  tool. It does so for `view_page` only; `view_graph`, `view_activity` and `view_review` are never
  called.
- `.claude/rules/mcp-request-path-and-tool-surface.md` says every widget tool's `resourceUri` is
  pinned. `test-app-resource.ts:117-138` covers only `registerBrainApp` tools, not `analytics`,
  `brain_access`, `members` or `connected_accounts`.
- `tests/ui/harness.ts` `ROUTES` omits `review`, so no sweep mounts the Review view.
- `e2e-librarian.ts:1134-1139` comment describes a different case from the one asserted (the
  resolve misroute). That misroute logic in `src/tools/importer.ts:335-340` is covered only here;
  consider moving the decision into `src/lib/findings.ts` and unit-testing it.

Headers and comments that describe older code (fix in passing):

- headers: `test-index.ts:4-9`, `test-structure.ts:1-4`, `test-page-patch.ts:1-6`,
  `test-views.ts:1-4`, `e2e-librarian.ts:1-28`, `scripts/test-ui.ts:22`
- comments: `test-probe.ts:50-51` (and `src/lib/probe.ts:54`, "path order"),
  `test-dedupe.ts:377`, `test-access.ts:41-42`, `test-access.ts:1610-1614`, `test-scope.ts:179-182`,
  `test-scope.ts:930-937, 962-963`, `test-policy.ts:53, 181-204`, `test-invites.ts:264-267`,
  `test-media.ts:65`, `test-preamble.ts:83-92`, `scripts/smoke.ts:134-135` and
  `test-smoke.ts:297` ("github identity mode" was removed), `web-nav.spec.ts:1, 164, 205-208, 87-91`,
  `e2e-librarian.ts:1176-1184, 1387`
- history comments to trim to the fact: `test-access.ts` 799-800, 946-947, 958-961, 1065-1067;
  `test-scope.ts:50-57`; `test-record.ts:6-7`; `test-tools.ts:171-173, 209`;
  `test-media.ts:192-195`; `test-render.ts:12-17, 117-119`

## Checked and kept

These looked like duplicates and are not:

- `scripts/smoke.ts` is the deploy smoke CLI and a library; `test-smoke.ts` tests it with stub
  fetches and pins its `deploy.yml` wiring. `tests/ui/smoke.spec.ts` is unrelated.
- `test-loading` and `loading.spec.ts`, `test-web` and `web-nav.spec.ts`: pure rules against mounted
  behavior, and each header says which owns what.
- `test-import` and `e2e-import`: planner against real index, ledger and commit behavior.
- `roundtrip-check` (the editor's ProseMirror round trip) and the frontmatter round trips in
  `test-structure` cover different modules.
- `test-protocol`'s resource read (per protocol era) and `test-app-resource` (metadata).
- `test-wiring`, `test-docs`, `test-hooks`: disjoint, and nothing they pin is dead.
- `e2e-librarian`'s sole-coverage sections: dedupe retries, the sha/version contract, binary
  attachments, org landing for `connect_brain`/`create_brain`, the `configure_brain` overwrite
  guard, the findings key round trip, custom tool invocation, and the read-ordering probe.

## Rollout

Six PRs, in order, each independently green:

1. Phase 0.1 (`brains` fast path, with its fixture fixed and break-tested).
2. Phase 0.2 and 0.3 (CI gates).
3. Phase 1 (blind checks), each break-tested; the PR description lists what was broken.
4. Phase 2 and Phase 3 together, since the e2e harness extraction is where the sleeps live.
5. Phase 4 and Phase 5 (deletions, moves, renames).
6. Phase 6 (prose), plus any rule sentence the earlier PRs made false.

Expected result: about 450 fewer lines, about 40s off the e2e batteries and 30 to 50s of UI worker
time, no lost coverage, and roughly fifteen assertions that can now fail.
