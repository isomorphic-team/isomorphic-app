# Design: guest access to a brain

Status: **built** (2026-09-14). Closes the last two "Known gaps" in
[`brain-level-permissions.md`](./brain-level-permissions.md) (no per-brain invite; you must be
an org member before a brain can be shared with you). Supersedes the shared-spaces model parked
on PR #43: see [`brain-seams.md`](./brain-seams.md) for what that branch tried and why it was
the wrong shape.

## The case

A consultancy builds a brain for a client inside its own organization and needs a few of the
client's people to read it, and perhaps edit it. Those people are not staff. Making them
members of the consultancy's org exposes the roster (every member can read every name and
email) and any org-visible brain, and invites the wrong mental model: they are not joining
anything, they are being shown one thing.

The same person may be shown two brains in one org, or one brain in each of three orgs. None
of that should need a membership anywhere.

## The model

A **guest** is a person who holds a `brain_memberships` grant on a brain in an organization
they do not belong to. That is the whole definition. No new table, no new role, no new column
on the grant.

- **Guest is derived, never stored.** `via: 'guest'` on the sharing panel means "has a grant,
  holds no membership in this org", computed at query time. If the guest later joins the org
  (`invite_member`), the same row reads `via: 'grant'` on the next call. A stored flag would
  drift the moment that happened.
- **A guest is capped at `editor`.** Deciding who reaches a brain is the org's decision, and
  `admin` on a brain is exactly that power. The cap sits in `effectiveBrainRole` (a
  non-member's role can never exceed editor, whatever the row says) and `share_brain` refuses
  to write an `admin` grant for a non-member, so the cap is never silent.
- **Everything else a guest gets is what the rule already gave a non-member**: read-only or
  editor on that one brain, nothing at org scope (`orgRole` is `null`, and every org gate
  reads null as "not a member"), no roster, no analytics people table, no other brain.

## What changed

**Resolution.** `listAccessibleBrains` used to start `FROM memberships`, so a grant held by a
non-member produced no row and was unreachable. It is now the UNION of two index-driven
queries, one from `memberships` and one from `brain_memberships`, each carrying whichever
`org_role` the person has in that brain's org (null for a guest). The existing dedupe already
folded several rows per brain to the highest role. `listBrainAccess` gained the same second
leg so the sharing panel shows guests, sorted after members.

**Invitation.** `invitations.brain_id` (migration `0009`, nullable, additive). A brain invite
keeps `org_id` (the brain's org, so nothing downstream learns a brain-less invitation) and
names the brain. `claimPendingInvites` plans it as a grant rather than a membership, in the
same pass, under the same rules: an existing grant is never rewritten, an expired or accepted
row is skipped, and claiming is keyed on the person's whole set of addresses.

**`share_brain`** is the one verb, unchanged in shape. An address with an account gets a grant
directly, member or not. An address with no account gets a brain invite, and the reply says
where they sign in. `access: 'none'` revokes a grant OR cancels a pending invite. It never
writes `memberships`, so sharing with an outsider cannot widen what they reach beyond the one
brain.

**The app.** The share form no longer says "they must already be a member". The panel shows a
guest row with a "Guest" caption and offers viewer or editor for it, never admin.

## What was deliberately not built

- **No invitation email.** `invite_member` sends none either; the deployment's only mail is
  the magic link. The person sharing tells the guest, and the tool's reply gives them the
  sentence to forward. Sending mail from the platform is a product decision about sender
  identity and deliverability, not a missing line of code.
- **No guest at org scope.** A guest calling `create_brain` is treated as any first-touch
  person: with `AUTO_PROVISION` on they get their own org, otherwise they are turned away.
  That is not a guest concept, it is the existing one.
- **No expiry on a guest grant.** Revocation is explicit (`share_brain` with `access: 'none'`,
  or the brain being disconnected, which drops every grant). The reader link in
  [`link-sharing-and-the-web-app.md`](./link-sharing-and-the-web-app.md) is the expiring,
  identity-free shape, for a different audience.
- **No audience grants** ("everyone who can reach brain X can reach brain Y"). Nothing has
  asked for it; a grant per person per brain is legible and the panel shows it.

## Tests

- `pnpm test:access`: the cap in the pure rule (a non-member's `admin` grant resolves to
  editor; a member's does not), a guest's brain appearing in `listAccessibleBrains` with a
  null org role, and a guest row on `listBrainAccess` with `via: 'guest'`.
- `pnpm test:invites`: a brain invite claims as a grant and writes no membership; an org
  invite is unchanged; a brain invite to someone who already holds a grant rewrites nothing.
- `pnpm test:scope`: `share_brain` writes a grant for an outsider with an account, refuses
  `admin` for them, writes a brain invite for an unknown address, and `access: 'none'` cancels
  it. The `outsider` persona from #86 still reaches nothing at org scope.

Each was verified red against the pre-change code, per the rule in `CLAUDE.md`.
