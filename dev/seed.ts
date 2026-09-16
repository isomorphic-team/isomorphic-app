// The DEFAULT brain's content, in one place, so every local host shows the SAME
// brain.
//
// Two hosts render this repo's app locally and they are different programs:
// `pnpm app:dev` (dev/harness.ts) serves it from memory to an MCP App in a
// sandboxed iframe over AppBridge, and `pnpm web:dev` (scripts/web-dev.ts)
// materializes it onto disk as a git repo for the local runtime to serve over
// HTTP. Seeding them separately makes the one comparison worth having useless:
// a difference you notice between the two hosts has to be a difference in the
// APP, not in what it was handed to render.
//
// `dev/fixtures.json` is the base. The augmentations below are here rather than
// in that file because each one exists to put a specific STATE on screen, and
// the reason is worth keeping next to it.

import PAGES from './fixtures.json';

// A 64x64 palette PNG, 128 bytes. Small enough to sit inline and a real image
// rather than a 1x1, so "did it render?" is answerable by looking.
export const SAMPLE_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAADFBMVEU7StZbje+Px/fv9P+rZWLWAAAAL0lEQVR42u3MMREAIAwEsEL9e2bBwW9/iYDMAHwnJBAIeoIbEggEPcGGBAJBTfAA1t8YAcvRfzcAAAAASUVORK5CYII=';

// Where that image is attached. Both hosts read this, so the rendered image and
// the missing-attachment note appear in the same places in each.
export const PERSONAL_ASSET_PATH = 'wiki/concepts/assets/vision-sketch.png';

// The OTHER two brains. Small and obviously distinct, because their whole job is to
// be tellable apart from the default and from each other: a brain-targeting bug
// (a call, or a URL, reaching the wrong brain) is only visible when the brains do
// not look alike.
//
// Here rather than inline in one harness because they are seed data, and half-shared
// seeds are how the two hosts drifted the first time: `pnpm web:dev` had one brain
// while `pnpm app:dev` had three, so the multi-brain behaviour could be exercised in
// the stubbed host and nowhere near the real tool handlers.
export const ACME_PAGES: Record<string, string> = {
	'wiki/index.md':
		'---\ntitle: Acme\n---\n\nKnowledge base for **Acme**. Start with our [[mission]] and the [[onboarding]] program.\n',
	'wiki/concepts/mission.md':
		'---\ntitle: Mission\n---\n\nAcme builds tools for small teams. See the [[content-pipeline]] for how we publish.\n',
	// Carries an attachment (seeded in the harness's asset map) plus a link to one
	// that does not exist, so both states show: a rendered image and the missing-file
	// note. The broken case is the one nobody remembers to look at.
	'wiki/programs/onboarding.md':
		'---\ntitle: Onboarding\n---\n\nOur flagship customer onboarding program. Run by [[lead]].\n\n![The onboarding flow](assets/onboarding-flow.png)\n\n![A diagram that was moved away](assets/gone.png)\n',
	'wiki/people/lead.md':
		'---\ntitle: Team Lead\n---\n\nLeads Acme; owns the [[mission]] and the [[onboarding]] program.\n',
	'wiki/playbooks/content-pipeline.md':
		'---\ntitle: Content Pipeline\n---\n\nHow drafts move from research to published KB pages.\n'
};

export const NORTHWIND_PAGES: Record<string, string> = {
	'wiki/index.md':
		'---\ntitle: Northwind\n---\n\nOperations wiki for **Northwind**. See the [[headquarters]] and [[intake]].\n',
	'wiki/facilities/headquarters.md':
		'---\ntitle: Headquarters\n---\n\nPrimary site. Intake follows the [[intake]] process; ops lead is the [[director]].\n',
	'wiki/protocols/intake.md':
		'---\ntitle: Intake\n---\n\nStandard intake process for [[headquarters]].\n',
	'wiki/people/director.md':
		'---\ntitle: Operations Director\n---\n\nOwns operational processes including [[intake]].\n'
};

// A FRESH object every call. The augmentations below append to page bodies, and
// mutating the imported JSON in place would double-append on a second call —
// which is exactly what happens once two hosts seed from the same module.
export function personalPages(): Record<string, string> {
	const pages: Record<string, string> = { ...(PAGES as Record<string, string>) };

	// An otherwise-empty folder (persisted by a hidden .gitkeep) so the preview
	// exercises the "empty folder shows" + "show hidden" behavior out of the box.
	pages['wiki/Projects/.gitkeep'] ??= '';

	// An attachment on a page of the default brain, so opening either host shows a
	// rendered image without uploading anything first. Two links: one that
	// resolves and one that does not, because the missing-attachment state is the
	// one nobody remembers to look at.
	pages['wiki/concepts/vision.md'] +=
		'\n![The shape of the thing](assets/vision-sketch.png)\n\n![A sketch that was moved away](assets/gone.png)\n';

	// The config file itself, so the "show hidden" toggle has the real system
	// files to reveal (mirrors prod, where every brain repo carries one).
	pages['.isomorphic.json'] ??=
		'{\n  "paths": {\n    "wiki/": "content",\n    "raw/": "source",\n    "wiki/log.md": "log"\n  }\n}\n';

	return pages;
}
