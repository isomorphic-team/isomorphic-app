# Adding a brain to an org (adopting a repo)

How to register an existing GitHub repo as a **brain** under an org, so it shows up
in that org's members' `brains` list / the nav switcher.

> **Prefer the tool.** `connect_brain` (admin+, `src/tools/brains.ts`) does all of
> this conversationally — it verifies the installation can reach the repo, rejects
> already-connected repos, and offers `configure_brain` when the layout isn't the
> default. Running `connect_brain` with no `repo` shows the eligible repos. This manual SQL
> runbook is the fallback / reference for what the tool writes. To onboard a whole
> **new customer org**, see [`onboarding-a-customer-org.md`](onboarding-a-customer-org.md).

## What a brain is

Just two things:

1. a **`brains` row** — `(brain_id, org_id, repo_owner, repo_name, visibility)` linking
   the org to the repo (`src/db/auth-schema.sql`), and
2. the org's **GitHub App installation being able to read/write that repo**.

Multiple brains per org are fully supported — `listAccessibleBrains` (`src/lib/orgs.ts`)
unions every brain in the orgs a person belongs to. Add the row and it appears in the
switcher immediately, at the member's org role, **no reconnect**.

## The one hard requirement: installation owner

An installation token can only touch repos under the GitHub owner the App is installed
on (`orgs.brain_owner` / the installation's account). So the repo you're adopting
**must live under that same owner**.

- Repo under the org's GitHub org (e.g. `acme-co/…`) → fine.
- Repo under your **personal** account → the org's installation can't reach it. Either
  transfer the repo into the org, or install the App on the account where it lives —
  which creates a _separate_ org row, not a second brain of the existing org.

## Steps

### 1. Make sure the App installation covers the repo

On GitHub: the org's **Settings → GitHub Apps → Isomorphic → Configure**. If the App is
installed on "All repositories," a new repo is covered automatically. If it's on
"Only select repositories," add the repo to the selection. (This is what grants the
installation token read/write to it.)

### 2. Find the org's `org_id`

```sh
pnpm exec wrangler d1 execute platform-db --remote \
  --command "SELECT org_id, name, model, installation_id, brain_owner FROM orgs;"
```

### 3. Register the brain row

Apply to **both** local and remote D1 (remote is what production reads):

```sh
BRAIN_SQL="INSERT INTO brains (brain_id, org_id, repo_owner, repo_name, visibility)
  VALUES ('brain-<name>', '<org_id>', '<owner>', '<repo>', 'org');"

pnpm exec wrangler d1 execute platform-db --local  --command "$BRAIN_SQL"
pnpm exec wrangler d1 execute platform-db --remote --command "$BRAIN_SQL"
```

- `brain_id` is any unique string (convention: `brain-<repo>`).
- `repo_owner`/`repo_name` are the GitHub repo coordinates; together they form the
  canonical `brainId` (`owner/repo`) the content index and tools use.
- `visibility` is `'org'` (all members) for now.

### 4. (Optional) describe the repo's shape with `.isomorphic.json`

An adopted repo keeps its own layout. Drop `.isomorphic.json` in its root to map paths
to roles; without it, defaults apply (`wiki/` content, `raw/` source, `wiki/log.md` log,
auto-routing direct-commit vs PR by branch protection).

```json
{
	"paths": {
		"docs/": "content",
		"transcripts/": "source",
		"docs/log.md": "log"
	}
}
```

Roles: `content` (editable pages), `source` (append-only evidence, `ingest` writes it),
`log` (tool-maintained changelog), `system` (out of scope; also the default for any
unmapped path). Longest prefix wins; `"."` maps the whole repo. Optional blocks:
`"writes": {"mode": "pull-request", "autoMerge": false}` and
`"index": {"fields": ["type"]}`. The legacy `contentRoots`/`sourceRoots`/`logPath`/
`ignore` shape is still accepted.

See `src/lib/brain-policy.ts` for the full schema and defaults.

### 5. Verify

Ask Claude "what brains do I have?" (or open the switcher). The new brain appears under
its org. The content index (`ensureFresh`) self-builds on the first read — no backfill.

## Removing / renaming a brain

- **Remove:** `DELETE FROM brains WHERE brain_id = '<brain_id>';` (local + remote). The
  repo and its content are untouched — you're only detaching it from the org.
- **Rename the label:** labels are derived (`brainLabel` in `src/lib/orgs.ts`) from the
  org name + repo; there's no stored label yet. To change what the switcher shows,
  rename the repo or (future) add a `brains.label` column.

## Notes

- **Roles are per brain via the org.** A member sees every brain in their org at their
  org role. Per-brain ACLs (`brains.visibility` beyond `'org'`) are a future refinement.
- **Cross-identity brains** (a repo under a _different_ email's org) need identity
  linking (multi-brain P2) — not covered here.
