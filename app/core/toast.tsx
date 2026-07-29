// Toast notifications + the promise-based confirm dialog. Depends only on the store,
// so both host plumbing and actions (which sit above this) can call toast()/askConfirm()
// without an upward import. The Toast/ConfirmDialog components are mounted by Root.

import { useEffect, useRef, useState } from 'preact/hooks';
import { useSyncExternalStore } from 'preact/compat';
import type { ConfirmRequest } from './types.ts';
import { subscribeStore, version, bump } from './store.ts';

// ---------- toast ----------

let toastFn: (text: string, isError?: boolean) => void = () => {};
function toast(text: string, isError = false) {
	toastFn(text, isError);
}

// ---------- confirm dialog ----------

let confirmState: ConfirmRequest | null = null;
function askConfirm(opts: {
	title: string;
	body?: string;
	confirmLabel?: string;
}): Promise<boolean> {
	return new Promise((resolve) => {
		confirmState?.resolve(false); // supersede any open dialog
		confirmState = {
			title: opts.title,
			body: opts.body,
			confirmLabel: opts.confirmLabel ?? 'Confirm',
			resolve
		};
		bump();
	});
}
function ConfirmDialog() {
	useSyncExternalStore(subscribeStore, () => version);
	const req = confirmState;
	if (!req) return null;
	const done = (ok: boolean) => {
		confirmState = null;
		bump();
		req.resolve(ok);
	};
	return (
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
			onClick={() => done(false)}
		>
			<div
				class="w-full max-w-xs rounded-lg border border-border bg-bg p-4 shadow-xl"
				onClick={(e) => e.stopPropagation()}
			>
				<div class="font-medium text-fg">{req.title}</div>
				{req.body && <div class="mt-1 text-sm text-muted">{req.body}</div>}
				<div class="mt-4 flex justify-end gap-2">
					<button
						type="button"
						onClick={() => done(false)}
						class="rounded-md border border-border px-3 py-1.5 text-sm text-fg transition-colors hover:bg-chip"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => done(true)}
						style="background:#dc2626"
						class="rounded-md px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
					>
						{req.confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}

function Toast() {
	const [state, setState] = useState<{ text: string; error: boolean; show: boolean }>({
		text: '',
		error: false,
		show: false
	});
	const timer = useRef<number>(0);
	useEffect(() => {
		toastFn = (text, error = false) => {
			setState({ text, error, show: true });
			clearTimeout(timer.current);
			timer.current = window.setTimeout(
				() => setState((s) => ({ ...s, show: false })),
				error ? 6000 : 2500
			);
		};
	}, []);
	if (!state.show) return null;
	return (
		<div
			class={`fixed right-3.5 bottom-3 max-w-[70vw] rounded-lg border bg-chip px-3 py-1.5 text-sm ${
				state.error ? 'border-[#d33] text-[#d33]' : 'border-border text-fg'
			}`}
		>
			{state.text}
		</div>
	);
}

export { toast, askConfirm, ConfirmDialog, Toast };
