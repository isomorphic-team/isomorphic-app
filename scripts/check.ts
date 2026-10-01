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

// Throw catchers for checks on a refusal. Each answers with a value a `check` can
// read, so a function that returns where it should throw fails the check rather
// than the battery.

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whether `fn` throws. */
export function throws(fn: () => unknown): boolean {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
}

/** Whether `p` rejects. */
export async function rejects(p: Promise<unknown>): Promise<boolean> {
	try {
		await p;
		return false;
	} catch {
		return true;
	}
}

/** The message `fn` throws (or its promise rejects with), or null when it completes. */
export function errorOf(fn: () => Promise<unknown>): Promise<string | null>;
export function errorOf(fn: () => unknown): string | null;
export function errorOf(fn: () => unknown): string | null | Promise<string | null> {
	try {
		const out = fn();
		return out instanceof Promise ? out.then(() => null, messageOf) : null;
	} catch (e) {
		return messageOf(e);
	}
}
