# Onboarding a customer org (Model B)

How to bring an existing company/team onto the **live** platform as a **Model-B**
(customer-owned) org: their brains are repos under **their** GitHub org, served
with **their** App installation token. Contrast Model A (platform-owned), where
brains live under the platform org.

There are two ways in. Both end in the same place: a `customer`-model `orgs` row,
an `owner` membership, and at least one adopted brain.

|                                          | Who drives it               | When to use                                                         |
| ---------------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| **Self-serve** (`connect_github_org`)    | the customer, inside Claude | the normal path — no operator SQL                                   |
| **Operator script** (`pnpm onboard-org`) | you, from the CLI           | white-glove setup, or pre-provisioning before the customer signs in |

---

## What a Model-B org is (three rows)

1. **`orgs`** — `model='customer'`, `installation_id` = the customer's install,
   `brain_owner` = `github_org_login` = their GitHub org.
2. **`memberships`** — the owner (and later, invited members).
3. **`brains`** — one row per adopted repo. Adopting is a separate step
   (`connect_brain`), because the customer picks which repos to expose.

The **installation-owner rule** still governs everything: a customer install's
token can only touch repos under that GitHub owner. Repos must live under the
customer's org (see [`adding-brains.md`](adding-brains.md)).

---

## Path A — self-serve (`connect_github_org`)

The customer does this themselves, entirely inside Claude. No operator SQL.

1. **Sign in.** The customer connects to your Worker's URL (`PUBLIC_BASE_URL`) from Claude and
   signs in (magic-link / SSO). First sign-in gives them a personal Model-A org.
2. **Run `connect_github_org`.** ("Connect our GitHub org.") The tool returns a
   GitHub App install link carrying a one-time `state` (stashed in `OAUTH_KV`
   under `pending_org_connect:<state>`, 1h TTL).
3. **Install the App.** They open the link, install Isomorphic on their GitHub
   **org** (not a personal account — org installs get `administration:write`),
   and select the repos to expose.
4. **GitHub redirects** to the App's Setup URL,
   `<PUBLIC_BASE_URL>/github/install-callback?installation_id=…&state=…`.
   The Worker resolves the installation's org (App JWT → `getInstallation`) and
   writes the `customer` org + `owner` membership for that user
   (`connectCustomerOrg`, `src/lib/org-connect.ts`). Idempotent: a re-install
   adopts the existing org instead of duplicating.
5. **Adopt a repo.** Back in Claude they run `connect_brain` (see
   [`adding-brains.md`](adding-brains.md)) to turn one of their repos into the
   org's first brain. Running `connect_brain` with no `repo` shows the eligible ones.

### Prerequisites (one-time, on the deployed Worker)

- **`GITHUB_APP_SLUG`** (the App's URL slug, e.g. `isomorphic-mind`) must be set
  on the Worker. It ships inline in `wrangler.jsonc` `vars`, so it deploys with
  the Worker on merge to `main` — no separate secret step. (Locally it comes from
  `.dev.vars`, written by bootstrap.) Without it the tool returns a clear "not
  configured" error.
- The App's **Setup URL** must point at `<worker-origin>/github/install-callback`
  (it already does — this is the same route that renders the post-install
  confirmation page).

---

## Path B — operator script (`pnpm onboard-org`)

The scripted replacement for hand-editing `src/db/seed-customer-org.sql`. Use it for
white-glove onboarding, or to pre-provision a customer so their first sign-in
lands them straight in the right org.

```sh
pnpm onboard-org \
  --github-org acme-co \
  --owner-email admin@acme.com \
  --repo handbook \
  --operator-email you@example.com     # or set OPERATOR_EMAIL in .dev.vars
```

What it does that raw SQL can't:

- **Resolves `installation_id` from GitHub** automatically (App JWT →
  `GET /orgs/{org}/installation`). No copy-pasting numbers.
- **Verifies `--repo` is reachable** by the installation before writing a brain
  row (the footgun `connect_brain` guards at runtime).
- **Bakes the operator email into `created_by`/`invited_by`**, so you can't
  accidentally set them to the customer (the seed template's trap). The script
  refuses if `--operator-email` equals `--owner-email`.
- Writes three `INSERT OR IGNORE` rows: the `customer` org, the adopted brain
  (if `--repo` given), and a pending **invitation** for the owner. Their next
  authenticated request claims it (`claimPendingInvites`) and drops them into
  this org instead of minting a personal brain. That holds whether or not they
  already have an account, and whether or not `AUTO_PROVISION` is on.

By default it's a **dry run**: it resolves + verifies against GitHub, prints the
SQL, and writes it to `ops/seeds-real/seed-<org>-org.sql` (gitignored). Nothing
touches D1 until you pass `--apply`:

```sh
pnpm onboard-org … --apply both     # local + remote D1
```

> **Prod safety:** applying `--apply remote` (or `both`) writes to production D1.
> Get an explicit go-ahead before doing that; a dry run + `--apply local` is
> always safe.

### Flags

| Flag                      | Default                       | Notes                                                                       |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `--github-org`            | _required_                    | the customer's GitHub org login                                             |
| `--owner-email`           | _required_                    | the email the owner signs in with                                           |
| `--repo`                  | —                             | KB repo to adopt as the first brain; omit to let them `connect_brain` later |
| `--operator-email`        | `$OPERATOR_EMAIL`             | founding-operator account for `created_by`/`invited_by`                     |
| `--org-name`              | the GitHub org                | display name                                                                |
| `--org-id` / `--brain-id` | `org-<slug>` / `brain-<repo>` | override the generated ids                                                  |
| `--role`                  | `owner`                       | invited role (`owner` \| `admin`)                                           |
| `--apply`                 | _(dry run)_                   | `local` \| `remote` \| `both`                                               |

If you omit `--repo`, no brain is written; the owner runs `connect_brain` after
signing in. (Writing the brain here keeps them from landing in a brainless org.)

---

## After onboarding

- The owner sees their org's brains in `brains` / the switcher, at their
  org role, with no reconnect.
- Add teammates with `invite_member` (admin+); invites are consumed at first
  sign-in.
- Adopt more repos with `connect_brain`; remove one with `disconnect_brain`.
- Fix a "connected but no pages" repo with `configure_brain` (writes
  `.isomorphic.json`). See [`adding-brains.md`](adding-brains.md).
