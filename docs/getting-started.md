# Getting started

How to connect Claude to an Isomorphic server and get your first brain.

This is the guide for **using** Isomorphic. To run a server of your own, see
[`self-hosting.md`](self-hosting.md). To work on the code, see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## What you need

An MCP client, and the URL of an Isomorphic server. That is all. You do not need a GitHub
account, a Cloudflare account, or anything installed locally. This guide uses claude.ai
because it renders the in-conversation app; [other MCP hosts](#other-mcp-hosts) get the same
tools, and the same app runs in a browser tab on a multi-tenant deployment (`/b/<owner>/<repo>/`).

Every Isomorphic server exposes MCP at **`/mcp`** on its own origin:

| Server                                | MCP endpoint                    |
| ------------------------------------- | ------------------------------- |
| The hosted service, run by Isomorphic | `https://mcp.isomorphic.sh/mcp` |
| Your own deployment                   | `https://<your-worker>/mcp`     |
| Local development (the Worker)        | `http://localhost:8787/mcp`     |
| A folder on your machine (`pnpm try`) | `http://127.0.0.1:8788/mcp`     |

The `/mcp` path is required. The bare origin returns 404.

## Connect it to Claude

In Claude, open **Settings → Connectors → Add custom connector**, and paste the endpoint
URL. For the hosted service:

```
https://mcp.isomorphic.sh/mcp
```

You will not be asked for a client ID or a client secret. The server supports Dynamic
Client Registration, so Claude registers itself: it fetches
`/.well-known/oauth-authorization-server`, finds the `registration_endpoint`, and creates
its own credentials.

Claude then sends you through sign-in. On a server running the default configuration
(`AUTH_MODE=oauth`), that is an **email magic link**: enter your
address, open the email, click the link, and you are returned to Claude with the connector
active.

Use a private window if sign-in redirects somewhere unexpected. Auth.js stores a
`callback-url` cookie that persists between attempts and can steer a later sign-in back to
a stale one.

## Your first brain

A brain is a GitHub repository full of markdown that holds your knowledge. You do not
create it on GitHub, and you never have to open GitHub to use it.

On the hosted service, signing in for the first time gives you your own organization
automatically, with no invitation needed. You will not have a brain yet, so the first tool
call you make replies:

> You don't have a brain yet. Create one with the Add a brain button, or ask me to create a
> brain (e.g. "create a brain called Personal").

Either works. Asking Claude to "create a brain called Personal" runs `create_brain`, which
scaffolds a fresh repository, makes it your active brain, and opens it. From there:

- **"Add a page about X"** writes a page.
- **"Show me my brain"** opens the viewer, with a file tree, editor, and link graph, inside
  the conversation.
- **"What do I know about X?"** searches it.

If you already have a GitHub repository of markdown you want to use, it has to be reached
through the GitHub organization that holds it, since your personal organization cannot adopt
repositories. Ask Claude to create an organization connected to that GitHub organization
(`create_org` with `github: true`, which has you install the Isomorphic GitHub App there),
then to connect the repository (`connect_brain`), which adopts it rather than scaffolding a
new one. See [`ops/onboarding-a-customer-org.md`](ops/onboarding-a-customer-org.md) and
[`ops/adding-brains.md`](ops/adding-brains.md).

## Connecting to your own instance

Identical, with your own origin:

```
https://<your-worker>/mcp
```

One difference if you deployed with `AUTH_MODE=static`, the single-shared-token mode
described in [`self-hosting.md`](self-hosting.md): there is no sign-in step. Your client
sends a fixed header instead.

```
Authorization: Bearer <MCP_BEARER_TOKEN>
```

Claude's custom-connector UI does not offer a place to type that header, so `static` mode
suits clients that let you set headers directly (Claude Desktop's config file, the MCP
Inspector) rather than the claude.ai connector flow. For a self-hosted instance that other
people sign into, use `oauth` and give everyone their own identity.

## Other MCP hosts

The endpoint is ordinary MCP over Streamable HTTP with OAuth, so any compliant host works,
and the server never calls a model itself: the host brings the model. What varies by host is
the UI, not the tools.

| Surface                                                            | Works with                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The tools (search, read, write, move, validate, views, import)     | Any MCP client: claude.ai, Claude Code, Claude Desktop, the MCP Inspector, and anything else that speaks the protocol.                                                                                         |
| The in-conversation app (viewer, editor, file tree, graph, roster) | Hosts that implement the [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) extension. claude.ai does; the MCP Inspector and VS Code Copilot render it too. Elsewhere the tools return text. |
| The same app in a browser tab                                      | Any browser, no MCP host: `https://<server>/b/<owner>/<repo>/<path>` on a multi-tenant deployment, with the same email sign-in. Locally, `pnpm try` serves it at `http://127.0.0.1:8788/b/local/<folder>`.     |

**Claude Code:**

```sh
claude mcp add --transport http isomorphic https://mcp.isomorphic.sh/mcp
```

**Claude Desktop** takes a remote MCP server in its config file, and **the MCP Inspector**
takes the URL directly, which makes it the fastest way to see raw tool output when
something looks wrong.

CLI flags and config shapes move faster than this page. Check the host's own documentation
if a command here does not match what you have installed.

## When it does not work

**The bare domain does nothing.** `https://mcp.isomorphic.sh` returns 404. The endpoint is
`https://mcp.isomorphic.sh/mcp`.

**A 401 from `/mcp` is correct** when you have not signed in. That response is what
prompts Claude to start the OAuth flow. It is a problem only if it persists after
sign-in.

**A new or renamed tool does not appear.** claude.ai caches a connector's tool list and
re-fetches only on a manual reconnect: **Settings → Connectors → update tools**. It does
not re-fetch on a new chat, and the server cannot push the change. Tool _behavior_ changes
need no reconnect, since the signature is unchanged.

**Sign-in lands somewhere unexpected.** The sticky `authjs.callback-url` cookie above.
Clear cookies for the origin, or use a private window.

**The app UI does not render.** Claude sometimes declines to mount the iframe even when
the protocol exchange is correct. Test the same server against another host (the MCP
Inspector, VS Code Copilot) to tell a host problem from a server problem.

**Tools fail with a permissions error.** Reads need `viewer`, writes need `editor`, and
those roles are per brain: being in the organization does not by itself open a brain, since a
new brain is private to whoever created it. Ask an admin of that brain to check your access
with `brain_access` and change it with `share_brain`. `members` shows your role in the
organization, which is a different question.

## Where to go next

- [`self-hosting.md`](self-hosting.md) to run your own server.
- [`../brain-template/AGENTS.md`](../brain-template/AGENTS.md) for the page conventions
  agents follow when writing your brain.
- [`../SECURITY.md`](../SECURITY.md) to report a vulnerability.
- [Discussions](https://github.com/isomorphic-team/isomorphic-app/discussions) for
  questions, or an issue for a reproducible bug.
