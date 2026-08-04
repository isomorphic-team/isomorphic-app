# Self-hosting Isomorphic

You can run the whole thing yourself. Isomorphic is open source under
[AGPL-3.0-only](../LICENSE): no seat cap, no license key, no code path that phones home.
Running a stock build obliges you nothing. The obligation appears if you **modify** it and let
others use your version over a network, in which case those users are entitled to your
modified source. See [`docs/licensing.md`](licensing.md) for the detail, including what the
copyleft does not reach (your brain content, and any MCP client).

This guide has four paths. Pick the smallest one that does what you need.

| Path                            | Who it is for                                             | You need                                        | Time     |
| ------------------------------- | --------------------------------------------------------- | ----------------------------------------------- | -------- |
| **0. A folder on your machine** | Trying it, or developing on it. No accounts at all.       | Node 24+, pnpm, git                             | ~2 min   |
| **1. Local only**               | Working on the app UI, or on the Worker                   | Node 24+, pnpm                                  | ~5 min   |
| **2. Single-tenant deployment** | One person or one small team, one brain, one shared token | The above, plus a GitHub token, plus Cloudflare | ~30 min  |
| **3. Multi-tenant deployment**  | Many people, several brains, roles, email sign-in         | The above, plus a domain and an email provider  | ~2 hours |

Path 0 needs no accounts of any kind, and is the fastest way to see the thing work. Path 2 needs no GitHub App and no
GitHub organization unless you choose them: a personal access token on one repository is
enough, and `pnpm doctor` will tell you what your `.dev.vars` is still missing.

---

## What you are actually running

Three programs from one `src/`:

- **The MCP Worker** (`src/worker.ts`), a Cloudflare Worker. It serves MCP tools to Claude and
  serves the in-client app UI. Uses D1 for a derived content index and, in multi-tenant mode,
  for orgs and members. Uses KV for OAuth state. This is paths 2 and 3.
- **The local runtime** (`src/local.ts`), a Node server that offers the same content tools over
  a git repository on disk, with no accounts and no cloud anything. This is path 0.
- **The bootstrap server** (`src/bootstrap.ts`), a Node script you run once. It registers a
  GitHub App for you and scaffolds your first brain repo, then you never run it again.

And one thing you own that is not code:

- **A brain**, which is an ordinary git repository full of markdown, on GitHub or on your own
  disk. Your knowledge lives there, in
  [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md),
  readable and editable without any of this software. If you stop using Isomorphic, you still
  have a git repo full of markdown.

Cloudflare is the only supported deploy target for a SHARED instance. Workers, D1, and KV are used
directly rather than through an abstraction layer, so porting to another runtime is real
work rather than a config change. The free tier is enough for a small team.

---

## Path 0: a folder on your machine

```sh
git clone https://github.com/isomorphic-team/isomorphic-app
cd isomorphic-app && pnpm install
pnpm try ~/Documents/notes
```

That is a real MCP server, with the real librarian tools and the real content index,
serving a directory of markdown. No GitHub account, no Cloudflare account, no tokens,
nothing to configure. Point a local MCP host at it:

```sh
claude mcp add --transport http isomorphic-local http://127.0.0.1:8788/mcp
```

**Your brain is a git repository.** If the folder is not one yet, `pnpm try` runs
`git init` and commits what is already there, so nothing you point it at can be lost.
Every write the tools make lands as a commit, which is what makes `view_activity`
meaningful and what makes an edit batch atomic. Edit files in your own editor whenever
you like: reads come from the working tree, so external changes show up on the next
call with nothing to sync.

An Obsidian vault works. So does any folder of markdown.

What path 0 does NOT have: other people. There is no org model, so no members, roles,
invitations, or brain sharing, and those tools are not registered rather than
registered and unable to answer. There is also no authentication, which is why it
binds to `127.0.0.1` only. The moment you want a second person, you want path 2 or 3.

The content index is kept at `.isomorphic/index.sqlite` inside the brain and is
gitignored for you; it is derived data and can be deleted at any time.

---

## Path 1: local only

```sh
git clone https://github.com/isomorphic-team/isomorphic-app
cd isomorphic-app
pnpm install
pnpm setup:config       # generates wrangler.jsonc with local placeholder ids
pnpm test               # the golden tests, offline, should be green
```

You now have two useful things:

```sh
pnpm app:dev            # http://localhost:5175, the real app UI over stub fixtures
pnpm worker:dev         # http://localhost:8787, the MCP server (needs credentials, below)
```

`pnpm app:dev` needs no credentials at all. It renders the actual `ui://` bytes the Worker
would serve, through the official MCP AppBridge host, over fixture data. It is the right
place to work on the viewer, the editor, the tree, or the graph.

`pnpm worker:dev` serves real MCP at `http://localhost:8787/mcp`, but it needs a credential
to reach a real repository. The cheapest is a personal access token on one repo, which is
option A of path 2's first step and takes a couple of minutes. You can then point Claude
Desktop, Claude Code, or the MCP Inspector at it. Run `pnpm doctor` if you are unsure what
your checkout is still missing.

### Why `wrangler.jsonc` is generated

`wrangler.jsonc` is gitignored. It holds one deployment's identity: the Worker name, the
public URL, and the Cloudflare KV and D1 resource ids. Those are per-deployment, not
per-repository, and Wrangler will not interpolate environment variables into resource
bindings, so the file is generated from `wrangler.template.jsonc` by `pnpm setup:config`.

The default profile writes obviously-fake ids. That is correct for local work:
`wrangler dev` and `wrangler d1 migrations apply --local` run against Miniflare, which
simulates KV and D1 on disk and never resolves an id against Cloudflare's API. The ids only
have to be real in order to deploy.

`pnpm setup:config --help` lists every setting, where it is read from, and its default.

---

## Path 2: single-tenant deployment

One brain, one shared bearer token, no accounts, no roles. Whoever holds the token can read
and write. This is a password on a door rather than an access-control model. It is fine for
one person or a handful of trusted people, and it is far less setup than path 3.

### 2a. Reach a brain

Two ways. Take the first unless you need the second.

**Option A: a token (recommended).** Make a repository for your brain, or pick one you
already have, then create a fine-grained personal access token at
[github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens)
scoped to that one repository, with **Contents: read and write** and **Pull requests: read
and write**. Put it in `.dev.vars`:

```sh
GITHUB_TOKEN="github_pat_…"
BRAIN_REPO_OWNER="your-account"
BRAIN_REPO_NAME="your-brain-repo"
```

That is the whole GitHub side. No organization, no App, no manifest flow, no installation
id, and nothing to convert. Commits are attributed to whoever owns the token, which for a
single user is what you want. An empty repository is fine; the librarian tools write into
it. Skip to 2b.

**Option B: a GitHub App.** Take this if you want commits authored by an App rather than by
a person, if the brain lives under an organization whose access you would rather manage as
an installation, or if you are heading for path 3, which requires it.

You need a **GitHub organization**, not a personal account. GitHub only grants the
`administration: write` permission (required to create repositories) to installations on
organizations. A free org takes a minute to create at
[github.com/account/organizations/new](https://github.com/account/organizations/new).

```sh
pnpm bootstrap          # opens http://localhost:3000
```

Three pages, roughly three clicks:

1. The form posts a [GitHub App manifest](../src/manifest.ts) to GitHub. The App's
   permissions are declared in code rather than clicked through a UI, so you get exactly the
   permissions listed there and nothing else. GitHub creates the App and redirects back with
   a one-time code.
2. That code is exchanged for the App's credentials, which are written to `.dev.vars`. The
   private key is converted from PKCS#1 to PKCS#8 on the way in, because the JWT library
   Octokit uses only accepts PKCS#8 and Workers cannot do the conversion at runtime.
3. You install the App on your org. The post-install callback creates and scaffolds your
   brain repository in a single atomic commit, and records the org and installation id.

If you already know your deployed URL, set `PUBLIC_BASE_URL` in `.dev.vars` **before**
running bootstrap and the OAuth callback for it gets registered on the App automatically.
Otherwise only `http://localhost:8787` is registered, and you add the deployed callback
later at `github.com/settings/apps/<your-slug>`.

If the install fails with a permissions error, you installed on a personal account rather
than an org. Bootstrap detects this and says so.

### 2b. Point local dev at your real brain

Add to `.dev.vars`, on top of whichever of 2a you did:

```sh
AUTH_MODE="static"
MCP_BEARER_TOKEN="…"           # openssl rand -hex 32
```

Option B also needs `GITHUB_APP_INSTALLATION_ID` and `BRAIN_REPO_OWNER`/`BRAIN_REPO_NAME`,
all written by bootstrap. `MCP_BEARER_TOKEN` is what your MCP client sends; it is separate
from the GitHub credential and authenticates the client to _you_, not you to GitHub.

Then:

```sh
pnpm doctor                    # says what is still missing, and what to run next
pnpm setup:config --force
pnpm db:migrate                # applies migrations/ to the local D1
pnpm worker:dev
```

Connect an MCP client to `http://localhost:8787/mcp` with
`Authorization: Bearer <MCP_BEARER_TOKEN>`. Confirm with `whoami` and `list_pages` before
you deploy anything. [`getting-started.md`](getting-started.md) covers connecting each host.

### 2c. Provision Cloudflare resources and deploy

```sh
pnpm exec wrangler login

WORKER_NAME=my-brain \
PUBLIC_BASE_URL=https://my-brain.<your-subdomain>.workers.dev \
  pnpm setup:config --provision --force
```

`--provision` creates the KV namespace and the D1 database if they do not exist, finds them
if they do, and writes their real ids into `wrangler.jsonc`. Then upload the secrets, which
are deliberately not in `wrangler.jsonc` and never committed:

If you took **option A** (a token), that is two secrets:

```sh
pnpm exec wrangler secret put GITHUB_TOKEN
pnpm exec wrangler secret put MCP_BEARER_TOKEN
```

`BRAIN_REPO_OWNER` and `BRAIN_REPO_NAME` are not secret; keep them in `.dev.vars` for local
runs and add them to the `vars` block of `wrangler.template.jsonc` (or set them with
`wrangler secret put` too, which also works) for the deployed Worker.

If you took **option B** (an App):

```sh
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY_BASE64
pnpm exec wrangler secret put GITHUB_APP_CLIENT_ID
pnpm exec wrangler secret put GITHUB_APP_CLIENT_SECRET
pnpm exec wrangler secret put GITHUB_APP_INSTALLATION_ID
pnpm exec wrangler secret put MCP_BEARER_TOKEN
pnpm exec wrangler secret put PLATFORM_ORG
pnpm exec wrangler secret put PLATFORM_INSTALLATION_ID
```

Apply the schema to the remote database **before** deploying code that depends on it, then
deploy:

```sh
pnpm exec wrangler d1 migrations apply platform-db --remote
pnpm worker:deploy
```

Your MCP endpoint is `https://<worker>/mcp`. Hand that URL to your users;
[`getting-started.md`](getting-started.md) is the page to point them at. If you put it on a
custom domain, bind the
domain in the **Cloudflare dashboard**, not with a `routes` block in the config. A `routes`
entry with `custom_domain: true` makes `wrangler dev` rewrite the request host, which breaks
the OAuth provider's host-based routing and forces a comment-out dance on every local run.
The template says this too.

### 2d. Automate the deploy (optional)

`.github/workflows/deploy.yml` deploys on push to `main`. It needs one secret and a set of
variables, because `wrangler.jsonc` is not committed and has to be regenerated in CI:

```sh
gh secret set CLOUDFLARE_API_TOKEN     # "Edit Cloudflare Workers" template, plus D1 edit
pnpm setup:config --print-ci           # prints the gh variable set commands, then run them
```

Without them the job skips with a warning rather than deploying something misconfigured.

---

## Path 3: multi-tenant deployment

Orgs, roles (`viewer < editor < admin < owner`), a member roster with invitations, several
brains per person, and email sign-in so nobody needs a GitHub account. This is the mode the
hosted service runs in, on the same code.

Do path 2 first and confirm it works, taking **option B** in 2a: multi-tenant means minting
a token per organization from one App installation, which a personal access token cannot do.
Then:

### 3a. Choose an identity mode

`IDENTITY_MODE=github` uses GitHub OAuth. Simplest, but every user needs a GitHub account,
which defeats much of the point if your users are not engineers.

`IDENTITY_MODE=authjs` uses Auth.js with an email magic link, so members never touch GitHub.
This is usually what you want. Two caveats, both from running it:

- Magic links are weaker than a redirect-based provider. Email prefetchers can consume a
  link, and cross-browser flows are fragile. A redirect-based OIDC provider (Google, your
  IdP) is the better primary and is on the roadmap; the Auth.js provider slot is already
  there.
- `authjs.callback-url` cookies are sticky and will silently steer a bare `/auth/signin`
  visit somewhere unexpected. Test in a private window.

### 3b. Configure and deploy

```sh
AUTH_MODE=oauth \
IDENTITY_MODE=authjs \
AUTO_PROVISION=true \
PUBLIC_BASE_URL=https://brain.example.com \
AUTH_EMAIL_FROM="Your Brain <login@example.com>" \
WORKER_NAME=your-brain \
  pnpm setup:config --provision --force

pnpm exec wrangler secret put AUTH_SECRET        # openssl rand -hex 32
pnpm exec wrangler secret put AUTH_RESEND_KEY    # from resend.com
```

The From domain must be verified (DKIM and SPF) with your email provider, or delivery is
limited to your own address. Magic-link sending stays inert until `AUTH_RESEND_KEY` is set,
so you can bring the OAuth flow up first and add email after.

Add `https://brain.example.com/oauth/github/callback` to your GitHub App's callback URLs if
bootstrap did not (it only does so when `PUBLIC_BASE_URL` was set at the time).

`AUTO_PROVISION=true` gives an unrecognized signed-in user their own org on first request.
Set it to `false` for an invite-only instance: an unknown user gets an error instead, and
you add people with `invite_member`.

### 3c. Your own account

The generic auto-provision path would create a brand-new empty brain for you, which is
usually not what you want if you already have one from path 2. `src/db/seed-operator-org.sql`
is a fill-in-the-placeholders template that maps your email onto an existing brain instead.
Apply it to both the local and remote database.

### 3d. Bringing on another organization

Two paths, both documented in [`docs/ops/onboarding-a-customer-org.md`](ops/onboarding-a-customer-org.md):
`connect_github_org` (self-serve, the org installs the App on their own GitHub org and
their brains stay under their ownership) and `pnpm onboard-org` (operator-driven, scripted).
[`docs/ops/adding-brains.md`](ops/adding-brains.md) covers adopting an existing repository as
a brain.

---

## Operating it

**Schema changes.** Managed by the Wrangler migrations framework in `migrations/`.
`pnpm db:migrate` locally, and CI applies `--remote` before deploying. Never run `--remote`
by hand from a laptop: the deploy is schema-first for a reason, and a migration applied out
of band can leave the running code ahead of or behind the schema. Migrations must stay
backward-compatible with the currently-running code for the length of a deploy window, which
means additive changes, and expand-then-contract for renames and drops. Details in
[`docs/ops/d1-migrations.md`](ops/d1-migrations.md).

**The content index.** Read tools query a derived index in D1 rather than scanning GitHub.
It is a cache and never the source of truth: every read first compares the branch HEAD to the
indexed commit and reindexes what changed. So an edit made on github.com, by another agent, or
by a merged pull request is picked up on the next read with no webhook and no manual step.
Existing brains populate the index lazily on first read; there is nothing to backfill.

**Product feedback (optional).** `submit_feedback` lets your users send a bug or an idea from
inside Claude, as an issue on a GitHub tracker. It is off unless you configure a destination,
and it deliberately does not use the platform GitHub App. That App has no `issues` permission
and should not gain one, since widening it would expand the scope of every installation.
Instead, point it at a repository and give it a credential of its own (a fine-grained PAT with
Issues: read and write on that one repository, or a second small App):

```sh
pnpm exec wrangler secret put FEEDBACK_REPO    # e.g. your-org/your-fork
pnpm exec wrangler secret put FEEDBACK_TOKEN
```

Reports are labelled `feedback` plus the kind (`bug`, `idea`, `other`). A fine-grained PAT
with Issues: write creates those labels on demand, so there is nothing to pre-seed; a
narrower credential files the report unlabelled rather than failing. Two things worth knowing
about the credential: the issue is authored by whoever owns it, so a PAT on your own account
makes every user's report look like yours (a machine account or a small GitHub App avoids
that), and a PAT expires, after which reports fail with a clear error to the reporter and
silence to you. Leave both secrets unset and the tool is not registered at all, so nobody's
reports go anywhere unexpected. Note the
destination is a _public_ tracker in most setups: the tool always shows the user the exact
issue text and requires an explicit confirmation before posting, publishes nothing about their
account, and records the reporter privately in D1 (`feedback_reports`) keyed by the opaque
report id printed in the issue. A per-user cap of ten reports a day bounds abuse.

**Backups.** Your knowledge is in a git repository, so it is already backed up everywhere it
is cloned. The D1 database holds only derived data plus org and membership rows. Losing the
index costs a rebuild; losing the org tables costs re-inviting people. Neither loses content.

**Upgrading.** Pull, `pnpm install`, `pnpm setup:config --force` (in case the template
changed), `pnpm db:migrate`, deploy. Read the release notes for anything flagged as a change
to the Open Knowledge Format, since that affects the files in your brain rather than just the
server.

---

## Troubleshooting

**"namespace not found" or "database not found" on deploy.** You deployed with the local
placeholder ids. Run `pnpm setup:config --provision --force`.

**The App cannot create repositories.** It is installed on a personal account. Only
organization installations get `administration: write`. Reinstall on an org.

**Bootstrap wrote a private key that Octokit rejects.** GitHub issues PKCS#1 and the JWT
library needs PKCS#8. Bootstrap converts on write and also migrates an older `.dev.vars` on
every run, so re-running `pnpm bootstrap` usually fixes it. Never hand-edit
`GITHUB_APP_PRIVATE_KEY_BASE64`.

**Edited `.dev.vars`, and `wrangler dev` still uses the old values.** Restart it. Wrangler's
reload does not reliably re-create existing Durable Object instances or re-read every var.

**The app UI does not appear in Claude.** Claude sometimes does not mount the iframe even
when the protocol exchange is byte-correct. It is a host-side issue and not fixable from the
server. Isolate it by testing the same server against a different MCP host (the MCP Inspector,
or VS Code Copilot). See [`docs/references.md`](references.md).

**Everything is slow, or scans stop at about 40 pages.** You are on a code path that predates
the content index, or the index is not being used. Read tools should be issuing one or two D1
statements, not fetching every page from GitHub.

**A tool you wrote as a page under `tools/` does not show up.** The transport is stateless and
cannot push a tool-list-changed notification, so the host only sees a new, renamed, or removed
custom tool after it reconnects. Editing an existing tool's body takes effect immediately.

---

## Getting help

Open a [discussion](https://github.com/isomorphic-team/isomorphic-app/discussions) for
questions, or an issue for a reproducible bug. Self-hosting problems are on topic, and a gap
in this page is worth reporting as one.

For anything security-related, see [`SECURITY.md`](../SECURITY.md) instead.
