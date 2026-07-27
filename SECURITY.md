# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Report privately, either way:

- **GitHub Security Advisories**, the **Report a vulnerability** button on the
  [Security tab](https://github.com/isomorphic-team/isomorphic-app/security/advisories/new).
  Preferred: it gives us a private thread with you and a CVE if one is warranted.
- **security@isomorphic.sh**, if you would rather not use GitHub or do not have an account.

Please include what you found, how to reproduce it, and what an attacker gets out of it. A
proof of concept helps a lot. If you are unsure whether something counts, report it anyway.

**What to expect:** acknowledgement within 3 business days, an assessment within 10, and a fix
or a documented decision not to fix before we ask you to disclose. We will credit you in the
advisory unless you would rather stay anonymous. We have no bug bounty, and we will say so
plainly rather than stringing you along.

Please give us 90 days before public disclosure, and less if we ask for less. If we go quiet
on you for 30 days, disclose; that is on us.

## Scope

**In scope:** this repository's code, including the MCP Worker, the bootstrap server, the
in-client app bundle, the D1 schema and migrations, and the brain-repo write path. Also in
scope: our hosted service at `mcp.isomorphic.sh`, as long as you test only against brains and
accounts you own.

**Out of scope:** findings that require a compromised Cloudflare account or a leaked GitHub App
private key (that is the threat model, not a bug); rate limiting on endpoints where the absence
is documented; missing hardening headers on pages that serve no content; and vulnerabilities in
third-party dependencies with no exploitable path in this code (report those upstream, and tell
us so we can bump).

Please do not run automated scanners against the hosted service, do not attempt denial of
service, and do not access, modify, or exfiltrate data in a brain you do not own. Testing
against your own self-hosted instance is always fine and is the easiest way to work.

## Areas worth your attention

If you are looking for somewhere to start, these are the parts of the system where a bug would
matter most, and where we would most like a second pair of eyes:

- **Tenant and brain isolation.** Every request resolves an org, a role, and a brain
  (`tenantContext` in `src/worker.ts`, `src/lib/orgs.ts`). A path that returns content from a
  brain the caller cannot reach, or that resolves the wrong installation token, is the most
  serious class of bug in this codebase. The content index is keyed by `owner/repo` and is
  meant to make crossing brains impossible; verify that.
- **Role enforcement on write tools.** Write tools pass `requires: 'editor'`; reads are open to
  `viewer`. A write reachable by a viewer is a real finding. So is a member-management guard
  that can be walked around: `src/tools/members.ts` deliberately makes `owner` unassignable and
  forbids editing your own membership, and those guards exist to prevent lockout and privilege
  escalation.
- **The OAuth bridge.** `src/oauth/` and `src/auth/config.ts` implement an OAuth 2.1 server in
  front of an upstream magic-link or GitHub identity, with the pending request stashed in KV
  across an email hop. State handling, nonce reuse, and redirect-URI validation are worth
  scrutiny. Email-based magic links are known to be weaker than a redirect-based provider
  (email prefetch, cross-browser flows); we say so in `CLAUDE.md` and are moving toward OIDC.
  A concrete exploit is still a finding.
- **User-defined (brain-authored) tools.** A page under `tools/` in a brain becomes an MCP tool
  (`src/lib/custom-tools.ts`, `src/tools/custom.ts`). Arguments are interpolated as **data**,
  never evaluated, the operation whitelist is read-only, and a custom tool cannot exceed the
  caller's existing access or shadow a first-party tool. That is the security claim. If you can
  break any part of it, especially by escaping interpolation into an executed path or reaching a
  write, we want to know immediately.
- **The write path's blast radius.** `write_page`, `move_page`, and `delete_page` repoint inbound
  links across a brain. An input that makes a write touch pages the caller did not name, or that
  writes outside the configured content root, is in scope. Note that `write_page` anchors must
  match exactly once by design, so a batch is never half-applied.
- **Secret handling.** The GitHub App private key, the Auth.js secret, and the Resend key live in
  Worker secrets and `.dev.vars`. Any code path that logs, returns, or reflects one of these into
  a tool response, an error message, or the app bundle is a finding. The generated app bundle is
  compiled into the Worker, so anything embedded there is public.

## For self-hosters

If you run your own instance, the things most likely to hurt you:

- `.dev.vars` is gitignored. Keep it that way. If you commit a GitHub App private key, rotate it
  at GitHub rather than deleting the commit.
- `AUTH_MODE=static` uses a single shared bearer token with no per-user identity and no roles.
  It is fine for one person on a private brain and is not an access-control model. Generate the
  token with `openssl rand -hex 32` and do not reuse it anywhere.
- Brains are ordinary GitHub repositories. GitHub's own permissions on that repository are part
  of your security boundary. A brain that should be private should be a private repo.
- The GitHub App's `administration: write` permission lets it create repositories in the
  installed org. Install it on an org that holds only brains, not on your main engineering org.

Security fixes are announced in GitHub Security Advisories on this repository. Watch the repo's
releases if you self-host.
