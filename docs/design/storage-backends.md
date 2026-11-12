# Design: brains on storage that is not git

Status: **proposed** (2026-11-12).

- Author: Jon Hansing (via Claude)
- Related: [`storage-and-tenancy.md`](storage-and-tenancy.md) (connections, bindings, step 5's
  second backend), [`brain-index-storage.md`](brain-index-storage.md) (the per-brain Durable
  Object and its Worker), [`local-first-development.md`](local-first-development.md) (the fs
  store), [`preview-environments.md`](preview-environments.md).

## 1. Summary

A brain is a folder of Open Knowledge Format markdown. Today that folder is always a git
repository, on GitHub or on disk. This document proposes letting the same folder live in
Microsoft OneDrive or SharePoint document libraries (one API, Microsoft Graph) and in Google
Drive, with every tool working unchanged.

The format does not change. Pages are `.md` files with `type:` frontmatter, folder notes are
`index.md`, links are wikilinks. What changes is the storage contract underneath: it currently
speaks git (commits, trees, blob SHAs, branches, pull requests), and these backends have none of
those. The proposal is to restate `BrainStore` in neutral terms with declared capabilities, give
each brain a write coordinator in a Durable Object so that non-atomic backends can still apply a
multi-file write safely, and then add the backends one at a time.

## 2. Scope

In scope: a brain whose files are OKF markdown, stored in a OneDrive folder, a SharePoint
document library folder, or a Google Drive folder (including a shared drive).

Out of scope, and not a later phase of this design: treating an organization's existing Word
documents or Google Docs as a brain. That is conversion and ingestion, it does not keep OKF as
the contract, and nothing here moves toward it.

What the backend gives a customer is the storage boundary they already operate: retention,
eDiscovery, DLP, residency and backup. People edit these brains through Isomorphic (the MCP tools
and the web app). Neither Word nor Google Docs edits `.md` files, so editing in the backend's own
UI is not a supported path. Editing through a sync client (OneDrive sync, Google Drive for
desktop) with a local editor is possible and is the main source of concurrent writes (section 7).

## 3. What is already in place

- **One seam.** `BrainStore` (`src/lib/brain-repo.ts`) is the only interface between tools and
  storage. Outside `brain-repo.ts`, `github.ts` and `bootstrap.ts`, only `scaffold-core.ts` calls
  octokit directly.
- **A second implementation.** `fsBrainStore` (`src/local/brain-store-fs.ts`) already reports a
  working-tree digest where GitHub reports a commit SHA, and refuses pull-request mode with an
  explanation. So two of the needed ideas exist: the revision is opaque, and a backend may lack a
  capability.
- **Bindings.** `storage_connections` and `brains.storage_connection_id` separate the credential
  that reads a brain from the org that owns it.
- **Durable Objects without losing previews.** A Worker that binds to a class implemented in
  another Worker (`script_name`) keeps version URLs and Worker Previews (`docs/references.md`).
  SQLite-backed objects are available on the Workers Free plan (Cloudflare's Durable Objects
  pricing page, checked 2026-11-12), so self-hosters on the free tier are not excluded.

## 4. Where git leaks through the seam

| Today                                                      | Used by                                                   | Graph / Drive                                                              |
| :--------------------------------------------------------- | :-------------------------------------------------------- | :------------------------------------------------------------------------- |
| `Head` (`commitSha`, `treeSha`)                            | index freshness (`brain-index.ts`), config loading, tools | A change token: Graph `delta` link, Drive `changes.getStartPageToken`      |
| `TreeEntry` blob SHA                                       | incremental reindex diffs                                 | Per-file eTag / cTag (Graph), `md5Checksum` or `headRevisionId` (Drive)    |
| `gitBlobSha()` computed locally for write-through          | `writeThroughIndex`                                       | Not computable locally. The version tag comes back from the write response |
| `commitFiles`: one atomic multi-file commit                | every write tool; `move_page` bundles repointed links     | No multi-file atomicity. Per-file writes                                   |
| `commitOrPR`, `writeHead`, `PendingPr`, `findOpenConfigPr` | protected brains, `configure_brain`                       | No pull requests                                                           |
| `listCommits` / `CommitEntry`                              | `view_activity`                                           | Per-file versions and an activity feed; no cross-file change               |
| `RepoWritePolicy` (`branchProtected`, `mergeMethod`)       | write mode selection                                      | No branches                                                                |
| `RepoRef` (`owner`, `repo`)                                | everything                                                | A drive id and a root folder id                                            |

## 5. Proposal

### 5.1 A neutral store contract with capabilities

Rename the concepts, not the behaviour. GitHub and fs keep passing every battery.

- **`Revision`** replaces `Head`: an opaque string the backend can compare for equality, plus
  backend-private detail. GitHub's is the commit SHA; fs's is the digest it already uses; Graph's
  and Drive's are change tokens.
- **`Entry.version`** replaces the blob SHA: an opaque per-file tag. The index diffs on it as it
  diffs on blob SHAs now. Write-through takes the tag from the write result instead of computing
  `gitBlobSha`.
- **`write(changes)`** replaces `commitFiles` and returns the new revision plus each file's new
  tag. Its contract states whether it is atomic.
- **`StoreCapabilities`**, declared by each implementation and checked by the tools:
  - `atomicWrite`: a multi-file write lands entirely or not at all (GitHub, fs).
  - `proposals`: the backend can hold a reviewable change (GitHub pull requests).
  - `history`: cross-file change history for `view_activity` (GitHub, fs).
- **`RepoRef` becomes a locator** typed per backend, which `storage-and-tenancy.md` step 5 already
  anticipated.

Nothing in OKF, the tool surface or tool descriptions changes in this step.

### 5.2 A write coordinator per brain

A backend without `atomicWrite` gets its multi-file writes through a coordinator: a
SQLite-backed Durable Object per brain, named by `brain_id`, in the same Worker as the index
object from `brain-index-storage.md` and reached the same way (`script_name`, RPC).

- **It serializes Isomorphic's writes to one brain.** Two tool calls cannot interleave their
  file writes.
- **It journals a write before applying it**: the intended files, their expected prior version
  tags, and progress. A write interrupted halfway resumes from the journal on the next call to
  that brain, or rolls back the files it already wrote to their recorded prior content. A
  journal entry is deleted once the write completes.
- **It is a separate class from the index object.** The index object holds only derived state
  and is purged with `deleteAll()`; the journal is not derived and must survive an index rebuild.
- GitHub and fs brains do not use it.

This is the first piece of the Durable Object Worker that needs to exist for storage. If the
index has not moved into objects by then, the Worker ships with the coordinator alone.

### 5.3 Protected brains without pull requests

A brain on a backend without `proposals` can still require review. The change is held by
Isomorphic instead of the backend: a proposal record in the coordinator holding the bundle,
listed and approved through the same tools that report pull requests today, and applied as an
ordinary coordinated write on approval. Whether this ships with the first backend or later is
open (section 9); until it ships, such a backend refuses pull-request mode as fs does.

### 5.4 History

`view_activity` on a backend without `history` reads the coordinator's log of completed writes
(who, when, which files, the change-record message) plus the backend's own per-file versions for
edits made outside Isomorphic. Isomorphic's writes are then fully attributed; outside edits show
the backend's author and time, without a message.

### 5.5 Freshness and the index

The index already checks the branch head before every read. On these backends that check is
"has the change token moved", answered by a delta call that returns nothing when nothing
changed. The delta response lists changed items by id, so the incremental reindex reads only
those. Graph's delta omits paths and says to track items by id; Drive is id-addressed
throughout. Both backends therefore keep an id-to-path map, rebuilt from a full listing when a
token expires (Graph answers `410 Gone`).

Webhooks are not built and are not needed: polling on read matches the current model.

## 6. The backends

**Microsoft Graph first** (OneDrive and SharePoint document libraries, one API).

- Path-addressed reads and writes (`/drive/root:/wiki/page.md:/content`), and a folder cannot hold
  two items with the same name, which matches OKF's path-based tools.
- Credential: an Entra ID app registration. Enterprise tenants expect app-only access scoped to
  named sites (`Sites.Selected`) with admin consent, not per-user delegated tokens. That is a new
  connection kind in `storage_connections`.

**Google Drive second.**

- Id-addressed: resolving a path walks folders, and two files in one folder can share a name.
  The adapter resolves paths through the id-to-path map, and `validate` reports a duplicate
  name as a defect.
- Credential: a service account with access to a shared drive, or OAuth for a personal Drive.

Both are network adapters with no git; neither needs `node:*`, so both run in the Worker.

## 7. Concurrent edits from outside Isomorphic

Sync clients and other tools can change a file between Isomorphic's read and its write.

- Writes are conditional on the version tag read, where the backend supports it, and fail as a
  conflict otherwise. The coordinator rereads, and the tool reports the conflict instead of
  overwriting.
- Sync clients create conflict copies (`page (1).md`, `page-HOSTNAME.md`). `validate` reports them
  as findings with the original page, so `resolve` can merge or dismiss.
- The coordinator closes the race only among Isomorphic's own writes. A sync client writing
  between a conditional check and a write on a backend without preconditions is detected on the
  next delta, not prevented.

## 8. Alternatives considered

| Option                                                                   | Decision                                                                                                                                                       |
| :----------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep git as the system of record and mirror the folder to Drive or Graph | Rejected: two sources of truth, a sync engine to own, and the customer's boundary holds a copy rather than the record.                                         |
| Store a git repository's objects inside the drive                        | Rejected: the files in the customer's storage are unreadable by anything but Isomorphic, which defeats the reason to use it.                                   |
| Coordinate writes with lease rows in D1 instead of a Durable Object      | Workable fallback. Contended writes retry on a lease, the journal lives in the platform database next to the system of record, and every step is a round trip. |
| Make every write single-file on these backends                           | Rejected: `move_page` repoints links in other pages, and a page write appends to `wiki/log.md`. The bundle is the unit of work (`brain-repo.ts`).              |

## 9. Order of work

Each step is its own pull request.

1. **The neutral contract.** `Revision`, opaque version tags, `write()`, `StoreCapabilities`, a
   typed locator. GitHub and fs implement it; write-through stops computing blob SHAs and takes
   tags from the write result. No behaviour change, covered by the existing batteries plus a
   capability test that a backend without `proposals` refuses pull-request mode.
2. **The coordinator object**, in the Durable Object Worker, behind an interface in `src/lib/`
   with an in-memory implementation for tests and the local runtime. A battery pins serialization,
   journal replay after an interrupted write, and rollback.
3. **The Graph store**, tested against an in-memory fake that reproduces delta tokens, `410`
   resync, eTags and name uniqueness, plus an e2e battery against a scratch folder (the twin of
   the GitHub `--github` mode). A new connection kind and `create_brain` / `connect_brain`
   options. `Revision` keeps git detail only the stores read (`branch`, `snapshot`,
   `pr`), and `PendingPr` sits in the neutral file; this step narrows `Revision` to an `id` plus
   store-private detail, so a Graph store does not invent a branch.
4. **Conflict copies and duplicate names in `validate`.**
5. **The Drive store**, same pattern as step 3.
6. **Proposals held by the coordinator** (section 5.3), when a customer on these backends needs
   review.

Relocation between a git backend and one of these (`storage-and-tenancy.md` step 5) is a copy of
the current files. History stays behind in the source repository.

## 10. Open questions

- **Conditional writes.** Graph's simple upload page documents no `If-Match` precondition, and
  Drive v3 documents none for content updates. Which write paths actually honour one decides how
  much of section 7 is prevention and how much is detection. Spike before step 3.
- **Change-token cost on remote calls.** A delta call per read is one round trip, as `getRef` is
  today. Measure against Graph and Drive throttling limits for a brain read many times a minute.
- **Large brains.** Graph's delta and Drive's change list page through results. A first full
  listing of a large folder needs the same budget and resume rule as any whole-brain index pass.
- **Media.** `read_media` and attachments read binary files through the store. Confirm Graph and
  Drive downloads fit the Worker's memory and response limits for the media sizes already allowed.
- **Proposals at launch.** Whether the first Graph customer needs protected brains (step 6) before
  or after direct writes.
