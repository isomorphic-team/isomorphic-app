# Adding a brain to an org (adopting a repo)

How to register an existing GitHub repo as a **brain** under an org, so it shows up
in the `brains` list and the app's switcher for the people who can reach it.

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
2. a **GitHub App installation able to read/write that repo**: the brain's storage
   connection (`brains.storage_connection_id`, `src/lib/storage-connections.ts`), or the
   org's installation when that is NULL.

Multiple brains per org are fully supported. `listAccessibleBrains` (`src/lib/orgs.ts`)
unions every brain a person can reach, and `effectiveBrainRole` decides at what role. Add
the row and it appears for those people immediately, **no reconnect**.

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
- `repo_owner`/`repo_name` are the GitHub repo coordinates. The content index keys on
  `brain_id`, so it must not change once the brain is in use.
- `visibility` is `'org'` (every member of the org, at their org role) or `'private'`
  (only org admins and people it is shared with). `connect_brain` writes `'private'` plus
  an admin grant for the caller; a hand-written `'private'` row with no grant is reachable
  only by org admins until someone shares it (`share_brain`).

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

Roles: `content` (editable pages), `source` (immutable evidence: read by agents, never
written by the tools), `log` (tool-maintained changelog), `system` (out of scope; also the default for any
unmapped path). Longest prefix wins; `"."` maps the whole repo. Optional blocks:
`"writes": {"mode": "pull-request", "autoMerge": false}` and
`"index": {"fields": ["type"]}`. The legacy `contentRoots`/`sourceRoots`/`logPath`/
`ignore` shape is still accepted.

See `src/lib/brain-policy.ts` for the full schema and defaults.

### 5. Verify

Ask Claude "what brains do I have?" (or open the switcher). The new brain appears under
its org. The content index (`ensureFresh`) self-builds on the first read — no backfill.

## Removing, renaming, or moving a brain

- **Remove:** `disconnect_brain`, or `DELETE FROM brains WHERE brain_id = '<brain_id>';`
  (local + remote). The repo and its content are untouched: you're only detaching it
  from the org.
- **Rename:** `configure_brain` with `name` (brain admin).
- **Move to another org:** `connect_brain` with the brain's name or id as `repo` and the
  destination `org`, then again with `confirm: true` (org admin in both orgs). The first call previews whose access changes. The brain
  keeps its storage binding, so it stays in the same GitHub account and is read
  through the same installation. See `docs/design/storage-and-tenancy.md`.

## Hosted and personal orgs cannot adopt

`connect_brain` refuses in an org whose connection is the platform's shared
installation (a personal org, or a `hosted` one made by `create_org`).
Adopting through it would let any org claim a repository another org's brain left
behind in the platform account. Those orgs create brains with `create_brain`, or
receive them by a move (`connect_brain` naming an existing brain).

A `brains` row written by hand (step 3 above) needs no `storage_connection_id`: a NULL
binding resolves through the org's installation, exactly as before migration 0010.

## Notes

- **Roles are per brain.** An org-visible brain is open to every member at their org
  role; a private one only to org admins and the people it is shared with, including
  guests from outside the org. `brain_access` shows who reaches a brain and why.
- **Cross-identity brains** (a repo under a _different_ email's org) are reached by
  linking the two addresses to one person (`link_identity`); resolution then unions
  across both.
