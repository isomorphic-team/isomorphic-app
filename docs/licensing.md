# Licensing

Isomorphic is **open source** under the [GNU Affero General Public License v3.0
only](../LICENSE) (`AGPL-3.0-only`), an [OSI-approved](https://opensource.org/licenses)
license. Read it, run it, fork it, deploy it, sell services around it. The one obligation that
matters: if you modify Isomorphic and let people use your modified version over a network,
those users are entitled to your modified source.

Contributors sign a [CLA](../CLA.md), which lets us also offer Isomorphic under commercial
terms to organizations that cannot accept the AGPL. Both choices are explained below.

Where this page and [`LICENSE`](../LICENSE) disagree, the license wins.

## The short version

| You want to                                                    | Allowed?                                 |
| -------------------------------------------------------------- | ---------------------------------------- |
| Read all of the source                                         | Yes                                      |
| Run it for your own company, on your own infrastructure        | Yes, free, no user limit, no obligations |
| Modify it privately and never share the changes                | Yes, as long as nobody else uses it      |
| Modify it and let your team or customers use it over a network | Yes, and you must offer them your source |
| Fork it publicly                                               | Yes, under AGPL-3.0                      |
| Sell hosting, consulting, or support around it                 | Yes                                      |
| Run a competing hosted service                                 | Yes, if you publish your modifications   |
| Embed it in a proprietary product you ship without source      | No, unless you buy a commercial license  |

There is no seat cap, no phone-home, no license key, and nothing in the code checks any of
this. Internal use is unrestricted.

## What AGPL actually requires of you

AGPL is GPL plus one extra clause, section 13, which closes the "software as a service" gap in
ordinary GPL:

- **Using it unmodified, however you like, obliges you nothing.** Run the hosted service,
  self-host a stock build, deploy it for a client. No source-offer duty, because you have
  nothing of your own to offer.
- **Modifying it triggers the duty only when other people use the modified version.** A patch
  on your laptop is yours. A patched Worker your colleagues talk to means those colleagues can
  ask you for the patched source, which in practice is a link to an internal repository.
- **It does not reach your knowledge.** A brain is markdown in your own git repository. It is
  data, not a derivative work of this software, and no part of the AGPL touches it.
- **It does not reach MCP clients.** Talking to an Isomorphic server over a network protocol is
  not linking. Claude, your scripts, and anything else that speaks MCP are unaffected.
- **It does not reach code that merely runs alongside it.** Separate programs communicating
  through an API or a database are separate works.

So the burden for a self-hoster is: if you fix a bug, publish the fix.

## Why AGPL, and not the alternatives

The requirements were: keep the option to commercialize, be OSI-approved open source, and let
people self-host without limits.

- **AGPL-3.0-only** meets all three. The copyleft is what preserves the commercial option: an
  organization that cannot ship AGPL code in their product has a reason to buy a license from
  us. Same model as MySQL, Qt, and Grafana.
- **Apache 2.0 or MIT** would be equally open and simpler, and would **close** the commercial
  option rather than preserve it. Nobody buys a license for something already licensed
  permissively, so the only business left is hosting and support. We wanted the door open.
- **FSL-1.1-ALv2 or BSL 1.1** would stop a competitor from hosting a rival service, which AGPL
  does not. Both are non-OSI, and we decided that credibility cost was not worth insurance
  against a threat we are not worried about. There are already plenty of knowledge-base
  products and the code here is not the moat.
- **SSPL** is AGPL with a much broader service-stack clause, is not OSI-approved, and is widely
  disliked. It buys protection we do not need.

The trade we accepted: **AGPL does not prevent someone from hosting Isomorphic and competing
with us.** They must publish their modifications, which deters some people, and that is all it
does. MongoDB and Elastic both left AGPL for this reason.

## The CLA, and what "commercialize later" means

Contributors sign a [Contributor License Agreement](../CLA.md) before their first merge. It is
one bot comment. You keep the copyright in your work.

The CLA grants us a license broad enough to offer the project under terms **other than** AGPL.
Without it, every contributor's copyright would bind us to AGPL for their lines, and a single
outside contribution would make it impossible to sell a commercial license covering the whole
codebase.

So "commercialize later" means:

1. **Selling hosting**, which needs no special rights and is the main plan.
2. **Selling commercial licenses** to organizations whose lawyers will not allow AGPL in a
   product they ship. This is the option the CLA exists to preserve, and it is what people mean
   by "dual licensing."

This is an asymmetry: we can relicense your contribution commercially and you cannot relicense
ours. What we give back is in section 6 of the CLA and binds us:

- Your contribution stays available under **AGPL-3.0 or another OSI-approved license**,
  permanently. We cannot take the open source version away or move it to a source-available
  license.
- We will not carve your work out of that. Every public release including your contribution
  stays open source.
- Your authorship stays in the history.

If that trade is not acceptable to you, say so in an issue rather than a pull request, and send
documentation fixes instead, which need no signature.

## Compliance if you run a modified copy

Section 13 says users interacting with your modified version over a network must be offered its
Corresponding Source. The FSF's own suggestion is a "Source" link in the interface. If you fork
and deploy:

- Keep your fork's source public, or offer it to your users some other durable way.
- Say where it is. A link in your app UI or your MCP server's instructions is enough.
- Keep the copyright notices and the `LICENSE` file intact.

Our own hosted service satisfies this by running unmodified `main` from a public repository,
which is also an invariant we hold for other reasons (see
[`docs/design/open-source-boundary.md`](design/open-source-boundary.md)).

## Trademarks

The license grants no trademark rights. You may say "built on Isomorphic" or "a fork of
Isomorphic"; please do not name your instance or your fork "Isomorphic", and do not use the
logo as your product's logo. This is the standard Mozilla-style split between code freedom and
name confusion.

## Commercial licensing

If the AGPL does not work for you, usually because you want to embed Isomorphic in a
proprietary product, we sell licenses that permit it. Email **legal@isomorphic.sh** with what
you are building, or
[open a Discussion](https://github.com/isomorphic-team/isomorphic-app/discussions) if the
question is one you do not mind asking in public.

## Applying the license to files

We do not put full license headers in source files. One `LICENSE` at the root covers the
repository, and `NOTICE` records the copyright and trademark position. The SPDX one-liner, if
your organization's policy requires per-file headers on your fork:

```
// SPDX-License-Identifier: AGPL-3.0-only
```

We use `AGPL-3.0-only` rather than `-or-later` deliberately, so that a future FSF version
cannot change our terms without us agreeing to it.

## Third-party code

Dependency licenses are in `package.json` and `pnpm-lock.yaml`; `pnpm licenses list` prints the
current inventory, and `NOTICE` lists the notable ones. Permissive dependencies (MIT, ISC, BSD,
Apache 2.0) are compatible with AGPL-3.0 and are what we use. A new dependency under a copyleft
license needs discussion in the pull request first, because it can constrain what we are able
to offer a commercial licensee.
