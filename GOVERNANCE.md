# Governance

Isomorphic is a small commercial project with a public codebase. This file says who decides
what, so that nobody has to guess.

## Who decides

Isomorphic (the company) maintains the project and holds final say on direction, on what ships,
and on the license. There is no foundation, no steering committee, and no vote. Pretending
otherwise would be theater.

What we commit to instead:

- **Design discussion happens in public issues.** Not in a private Slack that produces a
  finished pull request. If a decision was made somewhere else, we write down the reasoning in
  the issue.
- **There is no private roadmap that contradicts the public one.**
  [`docs/roadmap.md`](docs/roadmap.md) is what we are actually planning, in the order we
  actually plan to do it, including the parts that are unglamorous. When priorities change, that
  file changes.
- **Rejections come with a reason.** A one-sentence "not this, because X" beats a pull request
  that sits for six months.
- **Invariants are documented, not tribal.** [`CLAUDE.md`](CLAUDE.md) records why the design is
  what it is, including the failures that produced each rule. A contributor should be able to
  predict our review from it. When they cannot, that is a bug in the document.

## Becoming a maintainer

We add commit access based on a track record, not an application. Roughly: several merged
non-trivial pull requests, review comments on other people's work that turn out to be right, and
a demonstrated instinct for the invariants. If that describes you and nobody has offered, ask.

Maintainers can merge, triage, and release. Changes to the license, the CLA, or this file stay
with Isomorphic.

## Releases

`main` is deployed to the hosted service on merge, so `main` is expected to be shippable at all
times. The hosted service runs unmodified `main` from this public repository, which is how we
satisfy AGPL section 13 and is an invariant we hold for other reasons too (see
[`docs/design/open-source-boundary.md`](docs/design/open-source-boundary.md)).

Breaking changes to the Open Knowledge Format that brains are written in get called out in the
release notes, because a brain may be read by tools outside this codebase.

## Forking

The license permits forking, and after two years each release is Apache 2.0, so a fork can go
anywhere. If you fork because we are being slow, tell us; if you fork because we are being
wrong, tell us that too. Please give the fork its own name (see
[trademarks](docs/licensing.md#trademarks)).

## Changing this file

Open a pull request. Governance criticism is on topic and will not be treated as hostile.
