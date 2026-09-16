// The assertion helper the golden tests share.
//
// A factory, not a module-level counter: each battery owns its own state, so
// importing this cannot couple two scripts, and every battery still runs
// standalone as `tsx scripts/test-<name>.ts`.
//
// `done()` sets `process.exitCode` rather than calling `process.exit()`. The
// difference matters for the e2e batteries: they delete scratch repos and temp
// directories in a `finally`, and `process.exit()` inside the `try` would skip
// it, leaving a real repository behind on the platform org. Setting the code
// lets Node exit naturally once the event loop drains, which runs the teardown.

export interface Checker {
	/** Assert `cond`. `detail` is printed only on failure. */
	check(label: string, cond: boolean, detail?: string): void;
	/** Print the verdict and set the process exit code. */
	done(): void;
	/** How many checks have failed so far. */
	readonly failures: number;
}

export function checker(subject: string): Checker {
	let failures = 0;
	return {
		check(label: string, cond: boolean, detail?: string): void {
			if (cond) {
				console.log(`  ✓ ${label}`);
				return;
			}
			failures++;
			console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
		},
		done(): void {
			if (failures === 0) console.log(`\nAll ${subject} passed.\n`);
			else console.error(`\n${failures} ${subject} FAILED.\n`);
			process.exitCode = failures === 0 ? 0 : 1;
		},
		get failures(): number {
			return failures;
		}
	};
}
