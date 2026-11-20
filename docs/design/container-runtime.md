# Design: running the platform in a container, off Cloudflare

Status: **proposed** (2026-11-13).

- Author: Jon Hansing (via Claude)
- Related: [`local-first-development.md`](local-first-development.md) (the Node runtime and
  the D1 shim this builds on), [`storage-backends.md`](storage-backends.md) (the files
  object and the write coordinator), [`brain-index-storage.md`](brain-index-storage.md)
  (the index database), [`open-source-boundary.md`](open-source-boundary.md),
  [`../self-hosting.md`](../self-hosting.md).

## 1. Summary

Every multi-user deployment today is a Cloudflare deployment: the MCP Worker, the objects
Worker, D1, KV and R2. An operator who cannot use Cloudflare cannot run Isomorphic for a
team. The usual case is an organization standardized on another cloud (Azure, AWS, GCP) or
on its own hardware, whose policy rules out a new infrastructure vendor.

This document proposes a fourth program, the **Node host**: a Node process that imports the
MCP Worker's `fetch` handler unchanged and supplies every binding it expects from local
equivalents. D1 and KV become SQLite files, the two Durable Object classes run in process,
and R2 backups go to a directory or an object store. It ships as one container image that
runs as one replica with one persistent disk.

The Worker stays the only implementation of the server. The Node host adds bindings, not
behaviour, so a tool, a permission rule or a fix lands once and both runtimes get it.

## 2. Scope

In scope:

- One organization (or a few) on infrastructure it runs: a container platform, a VM, or
  Kubernetes, on any cloud or on premises.
- Everything the Worker does today in both auth modes: the tools, the web app, OAuth for MCP
  clients, email and Entra ID sign-in, orgs, roles, sharing, all three hosted storage kinds
  (GitHub, the platform's own files store, Google Drive), the content index, analytics.

Out of scope:

- **More than one replica.** Section 5.8 says why, and what scaling looks like instead.
- **A Postgres or other server database.** The SQL is SQLite's dialect through D1; porting it
  is a rewrite of every query with nothing gained at one-organization scale.
- **Changing the hosted service.** It stays on Cloudflare. The Node host is a deployment
  target for self-hosters, built from the same `main`.
- **Storage on Microsoft Graph** (OneDrive, SharePoint). That is step 4 of
  [`storage-backends.md`](storage-backends.md) and runs on both runtimes once built.

## 3. What ties the server to Cloudflare today

The Worker's entry point is a web-standard `fetch(request, env, ctx)`. Its Cloudflare
dependence is the contents of `env`, `ctx.waitUntil`, and one module import:

| Dependency                    | Used for                                                 | Files in `src/` that name it |
| ----------------------------- | -------------------------------------------------------- | ---------------------------- |
| `PLATFORM_DB` (D1)            | orgs, users, brains, roles, Auth.js tables               | 6                            |
| `INDEX_DB` (D1, optional)     | the content index                                        | 3                            |
| `OAUTH_KV` (KV)               | OAuth grants and tokens, active brain, pending connects  | 5                            |
| `WRITE_COORDINATOR` (DO)      | the per-brain write lane and journal                     | 1 (plus the objects Worker)  |
| `BRAIN_FILES` (DO)            | the files of a brain the platform holds                  | 1 (plus the objects Worker)  |
| `BACKUPS` (R2, optional)      | sealed backups of files-object brains                    | objects Worker only          |
| `cloudflare:workers` (module) | `DurableObject`; `WorkerEntrypoint` in the OAuth library | 2                            |

The pieces behind them are already runtime-portable:

- **D1** already has a Node implementation: `localD1` over `node:sqlite`, with
  `applyMigrations` applying `migrations/` and `migrations-index/`. FTS5, which the index's
  shadow search uses, is compiled into `node:sqlite`.
- **The files store** is `sqlFiles` over a `SqlDatabase`, and `pnpm test:store` already runs
  `sqlBrainStore` on `node:sqlite`.
- **The write coordinator** is `serialized` plus `sqlJournal` plus `landBundle`, all in
  `src/lib/write-coordinator.ts`; the Durable Object is a few lines around them.
- **Backups** write through the `BackupBucket` interface (put, list, delete), not R2 itself.
- **The OAuth library** (`@cloudflare/workers-oauth-provider` 1.2.4) needs only a KV
  namespace and `WorkerEntrypoint`. Verified on Node 25 with a stub class for
  `cloudflare:workers` and an in-memory KV: client registration, the PKCE authorization code
  flow, token and refresh grants, an authenticated API call (200) and an anonymous one (401)
  all behave as on Workers. It also needs `resourceMetadata`, which `oauthProviderForOrigin`
  already supplies.
- **Entra ID sign-in** exists (`src/auth/entra.ts`, per-org directory SSO) and is plain
  Auth.js over HTTP.

## 4. Options

| Option                                                                | Verdict                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Run the unchanged Worker under a Node host with local bindings** | **Proposed.** One server implementation; the host is binding adapters and an HTTP listener.                                                                                                                                    |
| B. Grow the local runtime (`src/local.ts`) into a server              | Rejected. `McpSession`, the OAuth and Auth.js wiring, org onboarding and storage opening live in `worker.ts` (about 1,800 lines). Rebuilding them around `local.ts` forks the server, and every later change would land twice. |
| C. `workerd` in a container                                           | Rejected. Open-source `workerd` has Durable Objects on local disk but no D1, KV or R2, so the bindings need shims anyway, inside a runtime that is harder to extend and debug than Node.                                       |
| D. Miniflare (`wrangler dev`) in production                           | Rejected. It is a development simulator, unsupported as a server, and brings the whole Wrangler toolchain into the image.                                                                                                      |
| E. Port the data layer to Postgres                                    | Rejected (section 2).                                                                                                                                                                                                          |

## 5. The proposed shape

### 5.1 The host program

A Node entry point (working name `src/host-node.ts`, with its adapters under
`src/host-node/`, all under `tsconfig.node.json`) that:

1. reads configuration from environment variables, the same keys the Worker reads, plus a
   data directory;
2. opens the SQLite databases and applies migrations on start;
3. builds an object of the Worker's `Env` type from the adapters in 5.2 and 5.3, so a binding
   added to `Env` and not supplied here fails `pnpm typecheck`;
4. serves the Worker's default export through `@hono/node-server`, as `src/local.ts` serves
   `serveMcp`, with a `ctx` whose `waitUntil` tracks the promise, logs a rejection, and is
   awaited on `SIGTERM` before exit.

The import of `cloudflare:workers` (by the OAuth library and by `src/objects/worker.ts`)
resolves to a small module exporting `WorkerEntrypoint` and `DurableObject` base classes. The
image is a single esbuild bundle with that module aliased; development runs it through a
Node module resolve hook.

### 5.2 D1 and KV

- `PLATFORM_DB` and `INDEX_DB` are `localD1` over two files in the data directory. The index
  gets its own file always, so step 5 of the index plan (dropping its tables from the
  platform database) needs no special case here.
- `OAUTH_KV` is a table in a third SQLite file: key, value, expiry. It implements the subset
  the code calls: `get` (text and `json`), `put` with `expirationTtl`, `delete`, and `list`
  by prefix with a cursor. Expired rows are filtered on read and swept on a timer.

### 5.3 The Durable Objects, in process

The host runs the real `WriteCoordinatorObject` and `BrainFilesObject` classes rather than
reimplementing them. Each `DurableObjectNamespace` binding is an adapter that keeps one
instance per name and hands its methods back as the stub. Each instance gets a state object
providing what the classes use: `storage.sql` over its own SQLite file
(`objects/<class>/<name>.sqlite`), `storage.transactionSync`, `getAlarm` and `setAlarm` over a
timer, `waitUntil`, and `id.name`.

What differs from Workers and needs care:

- **No RPC boundary.** On Workers a `FileBackend` crosses RPC and its functions become stubs;
  in process they are plain functions. `backendFromRpc` and `objectWriteCoordinator` rebuild a
  `WriteConflictError` from a plain `Error`; with no boundary the error arrives as the real
  class, which both must keep accepting.
- **One instance per name, for the process lifetime.** Workers can evict and restart an
  object; here it lives until the process exits. The journal already settles an interrupted
  bundle on the next call, so a process restart behaves as an object restart.
- **Alarms are timers,** re-armed on start from what each object stored, so a backup due before
  a restart still runs.

`pnpm test:wiring` forbids a value import of `src/objects/` outside that folder. The host
becomes the one named exception.

### 5.4 Origins behind a proxy

The OAuth provider is built per request origin (`oauthProviderForOrigin`) and advertises
that origin in its metadata. On Workers, `request.url` carries the public `https://` origin.
Behind a TLS-terminating proxy, Node sees `http://` and an internal host, and the provider
refuses `http` on a non-loopback host. The host therefore builds each request's URL from
`PUBLIC_BASE_URL` and does not trust `X-Forwarded-*` headers, which a client can set when the
proxy does not strip them.

### 5.5 Outbound fetches: a guard Cloudflare used to provide

Attachments fetched from a URL (`src/lib/media.ts`) are checked against private and
link-local addresses before the request, which stops a literal `http://169.254.169.254/`. The
comment there names the residual case: a public hostname that resolves to a private address.
On Workers it reaches nothing, because Cloudflare's fetch egresses to the public internet. In
a container inside a cloud network it reaches the instance metadata service and anything else
on that network. On Azure, the metadata service at `169.254.169.254` issues managed identity
tokens.

The host closes this at connect time: its global `fetch` uses an undici dispatcher whose DNS
lookup refuses private, loopback and link-local results, with the address ranges taken from
the same predicates `media.ts` uses, so the check covers every hop including redirects. This
is a security boundary and ships in the same change as the first runnable image, not later.

### 5.6 Sign-in

Both auth modes work unchanged. Email sign-in sends through Resend over HTTPS, so it needs
outbound internet and a Resend key; Entra ID needs an app registration in the operator's
tenant (`AUTH_ENTRA_CLIENT_ID`, `AUTH_ENTRA_CLIENT_SECRET`). An organization on Azure will
usually want Entra ID only, with no email path at all (open question 1).

### 5.7 The image and where it runs

One image: Node 24 slim, the bundle, the migrations, the generated app bundle. It runs as a
non-root user, listens on one port, writes only under the data directory, and serves
`/health` for the platform's probes. TLS terminates at the platform's ingress.

The data directory holds SQLite files, so it must be a block device the process owns, not a
network share: SQLite's locking is unreliable over SMB and NFS, and WAL mode does not work
there at all. On Azure, that means a VM with a managed disk running the container, or AKS
with an Azure Disk volume and a single-replica StatefulSet. Azure Container Apps and App
Service persist through Azure Files shares, which are network shares, so they are not
supported targets for the data directory. The same rule picks the target on any other cloud.

### 5.8 One replica

The write lane lives in the process's memory, and every SQLite file has one writer. A second
replica would admit two writers to a brain's lane and to each database. So the host runs as
exactly one replica, and the deployment manifests say so (`replicas: 1`, a `Recreate`
update strategy, a lock file in the data directory that refuses a second process). It scales
vertically. One organization's traffic is far below what one process serves; the Worker's
own per-request budgets (`MAX_SCAN_PAGES`, the index budgets) still bound each request.

A restart means a short outage. Clients reconnect, OAuth tokens survive in `OAUTH_KV`, and
the journal settles any interrupted write.

### 5.9 Backups and data

- **Files-object brains** back up through `BackupBucket` as now. The host provides a directory
  implementation and an Azure Blob Storage implementation, chosen by configuration. Backups
  stay sealed to `BACKUP_PUBLIC_KEY`.
- **The platform database and the KV file** are backed up by snapshotting the disk (Azure
  managed disk snapshots, or the platform's equivalent), documented in the self-hosting guide.
  D1's time travel has no equivalent here.
- **GitHub and Google Drive brains** keep their content where it is; the host holds only the
  derived index for them, which rebuilds on read.

## 6. What it costs to keep

- **A new binding lands twice:** in the wrangler templates and in the host. `pnpm typecheck`
  catches a missing one (5.1, step 3); the host battery catches one that is supplied but wrong.
- **Durable Object behaviour the classes start depending on** (a new storage call, a second
  alarm) needs the state adapter to grow. The classes run under it in the battery, so an
  unsupported call fails there.
- **The image is a release artifact.** It is built and tested in CI on every pull request,
  and published on release; how and where it is published is open question 3.

## 7. Testing

A new battery, `pnpm test:node-host`, offline and fork-safe like the rest:

- boots the host in process over a temporary data directory and runs `smokeOrigin`
  (`scripts/smoke.ts`) against it, so the deploy smoke's five checks hold on both runtimes;
- runs the OAuth flow from section 3's probe end to end against the host, in `oauth` mode;
- writes, reads and searches through MCP in both auth modes, against a files-object brain, so
  the in-process objects, the D1 shim and the KV shim are all on the path;
- interrupts a bundle mid-write, restarts the host, and checks the next call settles it;
- refuses an attachment fetch whose hostname resolves to `127.0.0.1` and to
  `169.254.169.254`, using a stub resolver.

`pnpm test:store` adds the files object running under the host's state adapter as one more
backend under the store contract. A CI job builds the image and runs the smoke against the
running container.

## 8. Order of work

1. **The host, static auth.** Entry point, D1 and KV adapters, the `cloudflare:workers` stub,
   the `waitUntil` tracker, origins from `PUBLIC_BASE_URL`, the outbound fetch guard. GitHub
   brains work. Battery: smoke, a tool round trip, the fetch guard.
2. **The objects in process.** The namespace and state adapters, timers for alarms, the
   directory `BackupBucket`. Files-object and Drive brains work. Battery: the store contract,
   the interrupted bundle.
3. **OAuth and sign-in.** `oauth` mode, Auth.js over the D1 shim (`D1Adapter` has not run on
   the shim yet), Entra ID. Battery: the OAuth flow.
4. **The image.** Dockerfile, bundle, the single-instance lock, a Compose file, the CI job.
5. **Azure.** The Blob `BackupBucket`, an AKS manifest and a VM walkthrough in
   `docs/self-hosting.md`, then one real deployment end to end with a real MCP client.

## 9. Open questions

1. **An Entra-only sign-in mode.** Today email sign-in is always the fallback. A deployment
   whose users are all in one tenant may want email off entirely.
2. **Email without Resend.** An operator without outbound access to Resend needs another
   HTTP mail provider (Azure Communication Services, SES) behind Auth.js's
   `sendVerificationRequest`.
3. **Where the image is published** (GitHub Container Registry under the project's
   organization is the default), and whether `ee/` features ship in the same image behind
   entitlements, as they do in the Worker.
4. **The Azure storage claim in 5.7** (Container Apps and App Service persist only through
   Azure Files) is from current documentation and is rechecked before step 5.

## 10. What changes when this is built

These say the opposite today and change in the pull request that makes them false:

- `CLAUDE.md`: "three programs, one `src/`" becomes four.
- `docs/architecture.md`: the runtime walkthrough.
- `docs/self-hosting.md`: "There is no Docker image and no Postgres path" (the Postgres half
  stays true), and a new path for the container.
- `docs/design/brain-index-storage.md`, section 4: "self-hosting stays Cloudflare-only" is
  no longer the reason to reject an external search service (the other reason stands).
- `.claude/rules/deploy-and-config.md`, and `pnpm test:wiring`'s rule on `src/objects/`.
