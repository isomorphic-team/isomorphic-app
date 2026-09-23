# Design: storage and tenancy

- Status: Partly built. Steps 1, 2, 2b and 3 built (storage connections,
  `src/lib/storage-connections.ts` and migration 0010; moving a brain between orgs with
  `connect_brain`, `src/lib/brain-move.ts`; one tenancy model,
  `src/lib/static-tenant.ts`; derived state keyed by `brain_id`, migration 0011). Steps 4
  to 6 not started.
- Author: Jon Hansing (via Claude)
- Date: 2026-09-22
- Related: `docs/design/brain-seams.md` (§6, identity is a key, never a path),
  `docs/design/org-roles-permissions.md`, `docs/design/brain-level-permissions.md`,
  `docs/design/guest-access.md`, `docs/design/open-source-boundary.md`

## 1. Summary

Three things the schema stores as one:

1. **Who owns a brain.** The org: its people, their roles, who can share and disconnect.
2. **What a brain is.** A stable identity that grants, links, the index and URLs hang off.
3. **Where its bytes live.** A repository on some git host, reached through some credential.

Today an org _is_ a GitHub App installation (`orgs.installation_id`, `orgs.brain_owner`),
a brain _is_ a GitHub repo (`brains.repo_owner`, `repo_name`), and a brain's identity _is_
its repo path (`owner/repo` keys the content index, the client-facing id and the web URL).
So a change to any one of the three changes the other two. Moving a brain to another org
changes the credential that reads it; moving its storage changes its identity.

The target model separates them:

```
Org ──owns──▶ Brain ──bound to──▶ Storage binding ──uses──▶ Connection
people,       opaque id, name,    backend + locator          a credential to one
roles         org_id, grants,     (github: owner/repo,       provider account, owned by
              visibility          azure: org/project/repo)   an org or by the platform
```

With that separation, two operations that are hard today become simple and independent:

- **Move a brain to another org** is a change to `brains.org_id`. Storage, grants, name,
  links and the index are untouched.
- **Relocate a brain's storage** re-binds it to another backend or account. Its identity
  does not change, so nothing downstream notices.

## 2. Motivating cases

- **A client brain outgrows the consultancy's org.** Two brains built for a client inside
  the consultancy's org need their own org, so the client can have its own roster and
  admins. The client does not use GitHub, and nobody on their side will ever see it.
  Today this is disconnect and reconnect, which silently drops every grant and pending
  invite, loses the display name, and (if the repo changes owner) breaks every link.
- **A customer on Azure DevOps.** A customer whose IT requires their knowledge to live
  in their own tenant, on Azure Repos. `BrainStore` already abstracts content reads and
  writes, but every org, every credential and every brain id assumes GitHub.
- **Self-hosters on GitLab or Gitea.** The same shape of work as Azure, for an
  open-source deployment.

## 3. What is already right

The content half is done. `BrainStore` (`src/lib/brain-repo.ts`) is the only interface
between the tool layer and a brain's storage, and the local runtime's fs + git store
proves a second backend works behind it. Nothing in the read or write path needs to
change for a new backend; it needs a new implementation of the ten operations.

The coupling is all in **tenancy and identity**: which credential reads a brain, what an
org is, and what a brain is called.

## 4. The model

### Connection

A credential to one provider account. Replaces `orgs.installation_id`.

| Column          | Meaning                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| `connection_id` | Opaque. Deterministic for GitHub App installations: `github-app:<installation id>`.        |
| `provider`      | `github` today; `azure-devops`, `gitlab` later.                                            |
| `kind`          | `github-app-installation` today; `github-token`, `azure-service-principal` later.          |
| `external_id`   | The provider's id for the credential (the installation id).                                |
| `account`       | The provider account it reaches (a GitHub org login).                                      |
| `owner_org_id`  | The org that administers it, or NULL for a **platform-owned** connection (hosted storage). |

**Using a connection is separate from administering it.** A brain bound to an org's
connection can move to another org, and that org's members can read and write that one
repository through it. They cannot list or adopt anything else through the connection:
listing and adoption belong to the connection's owner. A platform-owned connection has
no owner org, so no org can list or adopt through it at all. It exists to hold brains
the platform created.

### Storage binding

Where one brain's bytes live: a connection plus a locator. In step 1 the binding is one
column, `brains.storage_connection_id`, and the locator is the existing `repo_owner` +
`repo_name`, which is what a GitHub locator is. Step 5 generalizes the locator when a
backend needs a different shape (Azure's organization, project and repository).

A brain whose binding is NULL (every brain written before step 1, and any written by
old code during the deploy window) falls back to its org's installation, which is
exactly how it resolved before. The fallback is removed in step 6.

### Brain identity

A brain's identity must not be derived from where it is stored. Today `owner/repo` is
the content index key, the `brain` handle tools accept, the active-brain pointer and the
web URL. `brains.brain_id` is already a stored string rather than recomputed, so the
primary key is stable; the rest is step 3 and 4.

### Org

An org is people and roles, plus a **default connection** new brains are created on.
`orgs.model` stops meaning anything about storage. It currently carries two facts:

- **Personal or not.** `platform` orgs are the auto-provisioned personal ones, labelled
  "Personal".
- **Whose GitHub.** `customer` orgs use the customer's own installation.

Step 2 adds a third value, `hosted`: a named team org whose default connection is the
platform's. It is how an org is created for a client that does not use GitHub. It is
additive: every existing check compares against `platform` or `customer` by equality,
so neither old code nor new code misreads it. Step 6 replaces `model` with `personal`
plus the default connection.

## 5. Operations

### Move a brain to another org

`connect_brain(repo: <brain>, org, confirm)`. The same tool adopts a repository; it
moves instead when `repo` names, exactly, a brain the caller can see in another org.
(Exactly: a partial name falling through to a move would turn "adopt the repo called
wiki" into "move client-wiki".) Without `confirm` it writes nothing and returns a
preview:

- where the brain is stored, and that storage does not move;
- for every person affected, their access before and after, computed by
  `effectiveBrainRole` over the source and destination memberships (the single
  authority on access, so the preview cannot disagree with what happens next);
- what stays behind: usage history is per org and stays with the source.

With `confirm: true` it runs one D1 batch:

1. Pin the binding if it is still NULL, to the source org's connection. Without this,
   the fallback would silently start reading the brain through the destination org's
   installation, which cannot reach it.
2. `UPDATE brains SET org_id`.
3. Re-point the brain's pending invitations to the destination org.

Grants, visibility, read-only, the name, `brain_id`, the index and the web URL are all
untouched. The caller must be admin in **both** orgs: taking a brain out of an org is a
disconnect, and putting one into an org adds data to someone else's organization. Being
admin in the destination also means the caller keeps access through the org-admin
floor, so a move cannot lock out the person making it.

What a move deliberately does not do: change where the brain is stored. A brain moved
from a consultancy's org to a client's hosted org stays in the consultancy's GitHub
account, and the preview says so. Custody changing hands is relocation, a separate act.

### Rename a brain

`configure_brain(brain, name)`. A field write, beside the content layout that tool
already set: both are the brain's own settings, gated at brain admin. A call with only
`name` never touches the repository. There was previously no way to rename a brain.

### Relocate storage (step 5, not built)

Re-bind a brain to another connection or backend. Both ends are git, so relocation is a
history-preserving push from one remote to another. It runs as a job, not in the Worker,
which cannot run git. The brain's identity is unchanged, so grants, links and URLs
survive.

### Create and adopt

`create_brain` creates on the org's default connection and writes the binding.
`connect_brain` adopts a repository through the org's connection and writes the binding,
and refuses to adopt when that connection is platform-owned, since adopting through the
shared platform account would let any org claim repositories it does not own. Moving a
brain INTO such an org is allowed: a move reads nothing through the destination's
connection.

## 6. Tool surface

No tools added. The two gaps (move and rename) are split along their gates:

- **Move** is in `connect_brain`. From the caller's side that tool means "put this brain
  in this org", adopting a repo or moving a brain, and both are org-scope, gated at org
  admin.
- **Rename** is in `configure_brain`, beside the content layout: a brain's own settings,
  gated at brain admin.

A dedicated `update_brain` was built first and folded in before merge. Merging further,
into one `manage_brain` or `manage_org`, was considered and rejected: hosts decide
approval prompts from per-tool read-only and destructive hints and grant "always allow"
per tool, so a tool mixing reads with removals either prompts on every read or approves
removals silently. Merges follow shared gate, annotation class and meaning, as
`share_brain` already does for grant, change and revoke.

`create_org` replaced `connect_github_org` in step 2, so creating an org and choosing
where its storage lives are one verb: hosted by default, `github: true` for the
customer's own GitHub organization. A later backend is another option on the same tool,
not a new tool. `create_brain` / `connect_brain` later gain an
optional connection argument defaulting to the org's.

## 7. Migration path

Expand, then contract. Every step is backward-compatible with the code running during
its deploy window, because a rollback reverts code and never schema.

1. **Bindings (built).** `storage_connections` and `brains.storage_connection_id`,
   backfilled from `orgs.installation_id`. Brain resolution reads the binding and falls
   back to the org. `create_brain` and `connect_brain` write it. No behavior change for
   an existing brain.
2. **Move and rename (built).** Move in `connect_brain`, rename in `configure_brain`,
   the `hosted` org model, and
   `create_org`, which replaces `connect_github_org` and creates a hosted org in
   product (gated on `AUTO_PROVISION`) or starts the GitHub install.
   2b. **One tenancy model (built).** Every deployment runs the org model. A static
   (single-user) deployment writes its org, operator member, storage connection and brain
   from config on first use (`ensureStaticTenant`), recording `GITHUB_TOKEN` as a
   `github-token` connection that names the secret without holding it; `credentialFor`
   picks token or installation from the binding. GitHub sign-in (`IDENTITY_MODE=github`)
   and the per-user `tenants` table were removed (production held one row, unreachable
   under `authjs`). What differs between deployments is one capability, `multiUser`:
   whether anyone besides the operator signs in, which gates the people, sharing and
   brain-management tools and reaches the app as `features.people`. The local runtime
   (`pnpm try`) writes no rows: it has one person, no sharing and a separate index per
   folder, so there is nothing for the org model to decide there.
3. **Key derived state by `brain_id` (built).** The content index, write-retry ledger,
   usage counters and active-brain pointer are keyed by `brains.brain_id`
   (`brainRefs`, `isActiveBrain` in `src/lib/orgs.ts`). Migration 0011 re-keys existing
   rows in place, so nothing reindexes; a pointer still holding `owner/repo` matches
   until the caller next switches.
4. **URLs by brain slug.** `/b/<slug>/<path>`, with `/b/<owner>/<repo>/...` redirecting
   permanently: a URL is a contract. Tools accept `owner/repo` as an alias.
5. **A second backend.** An Azure Repos `BrainStore`, a service-principal connection
   kind, a generalized locator, and relocation. Built when a customer needs it, with an
   e2e battery against a scratch repository (the twin of the `--github` mode).
6. **Contract.** Drop the binding fallback, `orgs.installation_id`, `orgs.brain_owner`
   and `orgs.model` (replaced by `personal` and a default connection).

Provider-specific concepts that stay provider-specific, inside the store: pull requests
(`commitOrPR`), branch protection (`repoWritePolicy`) and commit attribution. Azure Repos
has equivalents of all three.

## 8. Open questions

- **Multiple customer orgs on one installation.** The backfill assigns a customer
  installation to the oldest org using it. Two customer orgs sharing one installation
  should not exist today; if one does, the second shares the first's connection.
- **Relocation for a platform-owned brain moving to a customer.** Needs step 5's job
  runner even for GitHub to GitHub, since a transfer between two installations is not
  something one installation token can do.
- **Usage history on move.** It stays with the source org. That is what the source org
  measured; if a destination wants the brain's history, that is a reporting question,
  not a data move.

## 9. Rejected alternatives

- **A separate `update_brain` for move and rename.** Built, then folded into
  `connect_brain` (move) and `configure_brain` (rename), which cost no new tool. The
  objection to the first, that `connect_brain` is about adopting storage, was a schema
  argument; from the caller's side it puts a brain in an org, which is what a move does.
- **Move by disconnect and reconnect.** Drops grants and invites, loses the name, and
  resets visibility, with nothing in either response saying so.
- **Re-point the binding to the destination org's connection on move.** Requires the
  repository to be physically transferred first, which ties a tenancy change to a
  storage change: the coupling this design removes.
