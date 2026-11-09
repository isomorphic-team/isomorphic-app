// The `instructions` field of the MCP server: guidance the host loads once per connection
// and the model reads as "how to use this connector". It holds what no single tool's
// description can: when to reach for the brain at all, how the tools relate, and the brain's
// conventions. Anything about one tool goes in that tool's description instead.
//
// Hosts cut it: Claude Code shows the model only the first SERVER_INSTRUCTIONS_LIMIT
// characters, so the most important guidance comes first and `pnpm test:instructions` fails
// past the limit.
//
// The local runtime (src/local.ts) serves the same string, so every sentence must be true in
// every mode: the hosted org model, single-tenant static mode (no org tools), and a git repo
// on disk under `pnpm try` (no org tools, no brain switching, nothing pushed anywhere).
//
// The SDK sends `instructions` in the `initialize` result and, on the 2026-07-28 protocol
// revision, in the `server/discover` result. Hosts read it once per connection, so it cannot
// name the active brain: that would go stale on switch_brain.

export const SERVER_INSTRUCTIONS_LIMIT = 4096;

export const SERVER_INSTRUCTIONS = `Isomorphic is the user's "brain": a personal or team knowledge base, kept as a wiki in a git repository, that you can search, read, edit, and show to the user in the Isomorphic viewer inside the conversation. Which tools you have depends on the deployment: a local or single-user setup has no organization, member, sharing or multi-brain tools. Use only the tools you have.

- ANSWER FROM THE BRAIN FIRST for anything specific to this user or their organization: their notes, projects, people, decisions, customers. Find pages with search_pages, then read them with read_page.
- SHOW, DON'T PASTE. Use read_page (not view_page) only when YOU need the raw content to reason over it; use view_page when the goal is for the USER to see it. Whenever you cite a specific brain page in an answer, open it with view_page too. edit_page opens the editor for the user to change a page by hand; your own changes go through write_page.
- WRITE ONLY WHEN ASKED. Every write tool commits to the brain's repository as it runs: there is no separate save or commit step, and a change you made is already committed. On a protected brain a write opens a pull request instead; tell the user the change is on its way rather than explaining git. write_page's \`content\` replaces the whole body, so to change part of a page use \`edits\` or \`append\`, and to change frontmatter use \`fields\`.
- THE ACTIVE BRAIN. A user can have several brains (personal, team, client). Tools act on the active one; pass \`brain\` to target another for one call without switching, or call switch_brain to change the active one. When you do not know which brain holds something, call search_pages with \`scope: "all"\`.
- ACCESS IS PER BRAIN, separate from organization membership. members and set_member_role cover someone's role in the organization; brain_access and share_brain cover who can reach one brain. Being in the organization, even as its admin, does not open a private brain.
- ONE PAGE = ONE CONCEPT. Brains follow the Open Knowledge Format: anything other pages should be able to link to (a person, vendor, system, project, decision) is its own \`.md\` file with a \`type:\` in its frontmatter, never a heading inside a bigger page. If you are about to write a heading per item, write a page per item and link them from the parent.
- FOLDER NOTES. A folder's overview page is \`<folder>/index.md\` (\`README.md\` on older vaults): the viewer opens it when the folder is clicked. It lists the folder's pages; it never holds their content. An overview under any other name is a loose page, so offer to move_page it to \`index.md\`.
- MATCH THE BRAIN YOU ARE IN. Before adding to a folder, read a sibling page and follow its \`type:\` values, frontmatter keys and granularity.
- TIDYING IS A LOOP, NOT A SWEEP. Run validate and work one finding at a time, reading the page before deciding. When a finding is deliberate, resolve it with "dismiss" and a reason so nobody is asked again. Prefer reversible moves: a \`status:\` field over deletion, and move_page to merge so inbound links follow.`;
