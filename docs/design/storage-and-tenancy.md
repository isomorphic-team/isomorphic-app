# Design: storage and tenancy

- Status: Steps 1 and 2 built (branch `storage-and-tenancy`). Steps 3 to 6 not started.
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

`update_brain(brain, org, confirm)`. Without `confirm` it writes nothing and returns a
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

`update_brain(brain, name)`. A field write. Brain admin, since the name is a property of
the brain rather than of the org. There was previously no way to rename a brain at all.

### Relocate storage (step 5, not built)

Re-bind a brain to another connection or backend. Both ends are git, so relocation is a
history-preserving push from one remote to another. It runs as a job, not in the Worker,
which cannot run git. The brain's identity is unchanged, so grants, links and URLs
survive.

### Create and adopt

`create_brain` creates on the org's default connection and writes the binding.
`connect_brain` adopts a repository through the org's connection and writes the binding,
and refuses when that connection is platform-owned, since adopting through the shared
platform account would let any org claim repositories it does not own.

## 6. Tool surface

One tool added, `update_brain`, which fills two gaps (rename and move). A move is a
change to a brain's own properties, so it sits beside rename rather than inside
`connect_brain`, which is about adopting storage.

Later steps change names without adding tools: `connect_github_org` becomes
`connect_storage` with a provider argument, and `create_brain` / `connect_brain` gain an
optional connection argument defaulting to the org's.

## 7. Migration path

Expand, then contract. Every step is backward-compatible with the code running during
its deploy window, because a rollback reverts code and never schema.

1. **Bindings (built).** `storage_connections` and `brains.storage_connection_id`,
   backfilled from `orgs.installation_id`. Brain resolution reads the binding and falls
   back to the org. `create_brain` and `connect_brain` write it. No behavior change for
   an existing brain.
2. **Move and rename (built).** `update_brain`, the `hosted` org model, and
   `pnpm onboard-org --hosted` to create a named org on platform storage.
3. **Key derived state by `brain_id`.** The content index, write-attempt ledger and
   active-brain pointer stop using `owner/repo`. A lazy rebuild, the same shape as an
   `INDEX_SCHEMA_VERSION` bump.
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

- **Move inside `connect_brain`.** Adoption and move look alike under the current
  schema, where both are "attach this repo to that org". Once storage is separate, a
  move touches no storage, and a tool about adopting storage is the wrong home for it.
- **Move by disconnect and reconnect.** Drops grants and invites, loses the name, and
  resets visibility, with nothing in either response saying so.
- **Re-point the binding to the destination org's connection on move.** Requires the
  repository to be physically transferred first, which ties a tenancy change to a
  storage change: the coupling this design removes.
