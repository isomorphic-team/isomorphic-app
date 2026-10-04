# Design: a dedicated data org for platform-stored brains

Status: **proposed** (2026-10-02). Nothing here is built.

## The problem

Personal and hosted orgs store their brains through the platform installation: one GitHub
App installation on `PLATFORM_ORG` (`src/lib/provision.ts`, `.claude/rules/org-model-and-permissions.md`).
`pnpm bootstrap` installs the App on whichever GitHub organization the operator picks, and the
obvious pick is the operator's own organization, the one that already holds their code. Then:

- **Customer brains sit next to the operator's code**, in the same repository list, search and
  notifications. Every owner of that organization sees every brain as a matter of course.
- **Membership leaks access.** A GitHub organization's base repository permission defaults to
  `read`, so anyone added to work on the code can read every brain in it.
- **Nothing separates looking from working.** Opening a customer's brain is the same click as
  opening a repository of one's own, and nothing marks it as a different kind of act.

## What this cannot fix

A hosted deployment reads, indexes and searches brain content on the operator's
infrastructure. The App's private key reaches every repository it is installed on, and the D1
content index holds copies of pages. Whoever runs the deployment can therefore reach the
content. Making it unreadable to the operator means encryption with keys the customer holds,
which rules out server-side search and the index: a different architecture, not a setting.

The goal here is narrower: customer data lives apart from the operator's own work, nobody can
read it by default, and reading it is a deliberate act that leaves a record.

For stronger guarantees there are two existing paths:

- **Customer-owned storage** (`create_org` with `github: true`, the `customer` org model). The
  brains live in the customer's own GitHub organization; they see the App's access in their
  audit log and can revoke it. The deployment still reads them while installed.
- **No operator at all**: the customer runs the deployment themselves (the code is
  AGPL-3.0), or a dedicated deployment runs in their own Cloudflare account.

## The proposal

Each deployment keeps platform-stored brains in a **data org**: a GitHub organization that
exists only to hold them.

| Setting                         | Value                                               |
| ------------------------------- | --------------------------------------------------- |
| Members                         | one owner account, used only for break-glass access |
| Base repository permission      | none                                                |
| Members can create repositories | off                                                 |
| Two-factor authentication       | required                                            |
| GitHub App                      | the platform App, installed on all repositories     |

`PLATFORM_ORG` and `PLATFORM_INSTALLATION_ID` name the data org and its installation. The
operator's code organization has no platform installation at all.

Nothing in the code changes for a new deployment: this is what `pnpm bootstrap` should be
pointed at. The changes are documentation (`docs/self-hosting.md` and the bootstrap page say
to create a dedicated organization and how to configure it) and a check: `pnpm doctor`, and
possibly the bootstrap install callback, reports when the platform organization's base
permission is not `none` or it has more than one member, read through the App's installation
token.

## Moving an existing deployment

An existing deployment has brains in the old organization, bound to the storage connection
`github-app:<old installation id>`. Moving them is a case of "Relocate storage" in
[`storage-and-tenancy.md`](./storage-and-tenancy.md#relocate-storage-step-5-not-built), and a
simpler one: GitHub's repository transfer keeps history, issues and settings, and redirects the
old URL, so no git push is needed.

Per deployment, once:

1. Create the data org with the settings above, and install the platform App on it.
2. Add a storage connection for the new installation (`githubAppConnectionId`), owned by the
   platform (`owner_org_id` NULL).

Per brain, as one step each so a brain is unreachable for seconds rather than for the whole
move:

3. Transfer the repository to the data org (`POST /repos/{owner}/{repo}/transfer`, by an
   account that owns both organizations).
4. Update the `brains` row: `repo_owner`, and `storage_connection_id` to the new connection.

Then:

5. Point every platform and hosted org's `orgs.default_connection_id` at the new connection,
   so new brains land in the data org.
6. Set `PLATFORM_ORG` and `PLATFORM_INSTALLATION_ID` to the data org and redeploy.
7. Uninstall the platform App from the old organization once no `brains` row binds the old
   connection.

Steps 2 to 5 are an operator script in the shape of `pnpm onboard-org`: a dry run by default
that prints the plan (each brain, its old and new owner, the connection rows it writes), and an
`--apply` that runs it. The plan is a pure function over the `brains` and `orgs` rows, tested
like `planBrainMove`. It writes real installation ids, so it runs against a deployment's D1 and
is never a committed migration.

Brains of `customer` orgs are untouched: they are bound to their own installations.

## Open questions

- **Does the content index key on the repository owner?** If it does, a transferred brain
  re-indexes on its next read, which is budgeted and resumable but not free for a large brain.
  Check before writing the script.
- **What does the data org's audit log cover on its plan?** Repository access by the owner is
  what the record is for. If the free plan's log does not show it, the plan choice is part of
  this design.
- **Where do the operator's own brains go?** A brain the operator uses themselves is still
  platform-stored data. Moving it too keeps the rule simple: the code organization holds code.
- **Previews** follow the same pattern: their throwaway organization gets the data org's
  settings ([`preview-environments.md`](./preview-environments.md)).
