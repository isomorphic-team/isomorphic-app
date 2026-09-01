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
