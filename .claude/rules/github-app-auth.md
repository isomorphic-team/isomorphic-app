---
paths:
  - "src/lib/github.ts"
  - "src/bootstrap.ts"
  - "src/manifest.ts"
  - "src/persist.ts"
---

# GitHub App auth

GitHub App auth uses two tokens (`src/lib/github.ts`):

- **App JWT**: signed locally with the PEM; App-level reads only (`appOctokit`).
- **Installation token**: minted via the JWT, scoped to one installation, 1h TTL
  (`installationOctokit`). This touches repos. Which installation a brain uses comes from its
  storage connection (see `.claude/rules/org-model-and-permissions.md`).

In static mode a fine-grained PAT (`GITHUB_TOKEN`) can replace the App; `credentialFor`
(`src/lib/storage-connections.ts`) picks token vs installation from the binding. `oauth` mode
still requires the App.

Permissions are declared in `src/manifest.ts`. `administration: write` is required to create
repos and is **only granted on Organization installs**; the install callback refuses a personal
account install with a friendly error. **Never add an `issues` (or any widening) permission to
the platform App**; feedback uses its own `FEEDBACK_TOKEN`.

## PKCS#1 vs PKCS#8 (don't break this)

GitHub returns App private keys in **PKCS#1**; `universal-github-app-jwt` accepts only
**PKCS#8**. Bootstrap normalizes with `toPkcs8Pem()` (`src/bootstrap.ts`,
`node:crypto.createPrivateKey().export({type:'pkcs8'})`), at manifest exchange and as a
migration on every `pnpm bootstrap` run. **Do not move this conversion into `lib/`**: Workers
have no `node:crypto`.
