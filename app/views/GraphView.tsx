// ---------- graph view ----------

import { useEffect, useRef } from 'preact/hooks';
import type { GraphNode, GraphLink, SimNode } from '../core/types.ts';
import { displayMode } from '../core/host.ts';
import { navigateTo } from '../core/actions.ts';
import { defineView } from '../core/view-registry.ts';

// Read the current theme tokens straight off the document so the canvas draws in
// the host's palette (and re-reads on theme change — see the observer below).
function readGraphColors() {
	const cs = getComputedStyle(document.documentElement);
	const g = (v: string, fb: string) => cs.getPropertyValue(v).trim() || fb;
	return {
		bg: g('--c-bg', '#ffffff'),
		fg: g('--c-fg', '#1a1a1a'),
		muted: g('--c-muted', '#6b6b6b'),
		border: g('--c-border', '#e4e4e4'),
		accent: g('--c-accent', '#4f46e5')
	};
}

// A stable per-folder hue so pages in the same area share a color (Obsidian's
// group coloring). Empty group (root pages) gets a neutral hue.
function groupHue(group: string): number {
	if (!group) return 220;
	let h = 0;
	for (const ch of group) h = (h * 31 + ch.charCodeAt(0)) % 360;
	return h;
}

// Obsidian-style force-directed graph on a canvas. No graph library (bundle
// budget + iframe CSP) — a compact O(n²) spring layout, fine for the content-scan
// ceiling (~40 nodes). Drag to pan, scroll to zoom, drag a node to reposition,
// click a node to open its page. The layout pre-settles synchronously so the
// first paint is stable, then a cooling rAF loop keeps it live for interaction.
function GraphView({
	nodes,
	links,
	focus,
	truncated
}: {
	nodes: GraphNode[];
	links: GraphLink[];
	focus?: string;
	truncated?: boolean;
}) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const tall = displayMode === 'fullscreen';

	useEffect(() => {
		if (!nodes.length) return;
		const canvas = canvasRef.current!;
		const wrap = wrapRef.current!;
		const ctx = canvas.getContext('2d')!;

		// ---- build the simulation ----
		const sim: SimNode[] = nodes.map((n, i) => {
			// Seed on a circle (deterministic — no Math.random, unavailable here) so the
			// initial spread is even and the pre-settle converges the same way each open.
			const a = (i / nodes.length) * Math.PI * 2;
			const r = 40 + (i % 7) * 24;
			return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, fixed: false };
		});
		const byId = new Map(sim.map((s) => [s.id, s]));
		const edges = links
			.map((l) => ({ a: byId.get(l.source), b: byId.get(l.target) }))
			.filter((e): e is { a: SimNode; b: SimNode } => !!e.a && !!e.b);
		// Adjacency, so hover can highlight a node's immediate neighbors.
		const neighbors = new Map<string, Set<string>>();
		for (const s of sim) neighbors.set(s.id, new Set());
		for (const e of edges) {
			neighbors.get(e.a.id)!.add(e.b.id);
			neighbors.get(e.b.id)!.add(e.a.id);
		}

		const radiusOf = (n: SimNode) => 4 + Math.sqrt(n.degree) * 2.6;

		// One physics step. Repulsion (all pairs) + link springs + gravity toward the
		// origin so disconnected nodes don't drift away. `alpha` scales the whole step
		// so motion cools to rest.
		const LINK_LEN = 78;
		const MAX_STEP = 14; // max world-units a node moves per tick (smooths the settle)
		function tick(alpha: number) {
			for (let i = 0; i < sim.length; i++) {
				const a = sim[i];
				for (let j = i + 1; j < sim.length; j++) {
					const b = sim[j];
					let dx = a.x - b.x;
					let dy = a.y - b.y;
					let d2 = dx * dx + dy * dy;
					if (d2 < 0.01) {
						dx = (i - j) * 0.1 + 0.05;
						dy = 0.05;
						d2 = dx * dx + dy * dy;
					}
					const d = Math.sqrt(d2);
					const rep = (2600 / d2) * alpha;
					const fx = (dx / d) * rep;
					const fy = (dy / d) * rep;
					a.vx += fx;
					a.vy += fy;
					b.vx -= fx;
					b.vy -= fy;
				}
			}
			for (const e of edges) {
				const dx = e.b.x - e.a.x;
				const dy = e.b.y - e.a.y;
				const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
				const f = ((d - LINK_LEN) / d) * 0.08 * alpha;
				const fx = dx * f;
				const fy = dy * f;
				e.a.vx += fx;
				e.a.vy += fy;
				e.b.vx -= fx;
				e.b.vy -= fy;
			}
			for (const n of sim) {
				n.vx -= n.x * 0.012 * alpha;
				n.vy -= n.y * 0.012 * alpha;
				if (n.fixed) {
					n.vx = 0;
					n.vy = 0;
					continue;
				}
				n.vx *= 0.82;
				n.vy *= 0.82;
				// Cap per-tick displacement so a tight initial cluster eases apart over
				// several frames (a graceful settle) instead of snapping open in one.
				const sp = Math.hypot(n.vx, n.vy);
				if (sp > MAX_STEP) {
					n.vx = (n.vx / sp) * MAX_STEP;
					n.vy = (n.vy / sp) * MAX_STEP;
				}
				n.x += n.vx;
				n.y += n.vy;
			}
		}

		// ---- view transform (screen = pan + world * scale) ----
		const view = { panX: 0, panY: 0, k: 1 };
		let W = 0;
		let H = 0;
		const toWorld = (sx: number, sy: number) => ({
			x: (sx - view.panX) / view.k,
			y: (sy - view.panY) / view.k
		});
		// The view transform that frames the current node bounds with a margin.
		function computeFit(): { k: number; panX: number; panY: number } | null {
			if (!sim.length || W <= 0 || H <= 0) return null;
			let minX = Infinity,
				minY = Infinity,
				maxX = -Infinity,
				maxY = -Infinity;
			for (const n of sim) {
				minX = Math.min(minX, n.x);
				minY = Math.min(minY, n.y);
				maxX = Math.max(maxX, n.x);
				maxY = Math.max(maxY, n.y);
			}
			const bw = Math.max(maxX - minX, 1);
			const bh = Math.max(maxY - minY, 1);
			const margin = 70;
			const k = Math.max(0.25, Math.min(2.2, Math.min((W - margin) / bw, (H - margin) / bh)));
			return { k, panX: W / 2 - ((minX + maxX) / 2) * k, panY: H / 2 - ((minY + maxY) / 2) * k };
		}
		function fit() {
			const t = computeFit();
			if (t) Object.assign(view, t);
		}
		// Ease the camera toward the current fit — used during the intro settle so the
		// view zooms out smoothly as the graph blooms open (Obsidian-style), instead of
		// nodes drifting out of frame or a hard snap.
		function easeFitToward() {
			const t = computeFit();
			if (!t) return;
			view.k += (t.k - view.k) * 0.12;
			view.panX += (t.panX - view.panX) * 0.12;
			view.panY += (t.panY - view.panY) * 0.12;
		}

		let colors = readGraphColors();
		let hover: SimNode | null = null;
		let alpha = 1;
		// While true, the boot settle is playing: the loop keeps ticking and the camera
		// auto-fits. Cleared when the sim cools or the user interacts (so we don't fight
		// their pan/zoom).
		let intro = false;

		// Hubs labeled by default: the most-connected nodes (degree > 0). A small count
		// that scales gently with graph size and is capped, so a large brain shows a
		// handful of anchor labels — not a wall of text — with collision-avoidance (in
		// draw) preventing overlap. Hovering reveals any other node's label on demand.
		const HUB_LABELS = Math.min(14, Math.max(5, Math.round(sim.length * 0.12)));
		const hubIds = new Set(
			[...sim]
				.filter((n) => n.degree > 0)
				.sort((a, b) => b.degree - a.degree)
				.slice(0, HUB_LABELS)
				.map((n) => n.id)
		);

		function draw() {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, W, H);
			const hi = hover ? neighbors.get(hover.id)! : null;
			const dim = !!hover;

			// edges
			ctx.lineWidth = 1;
			for (const e of edges) {
				const lit = hover && (e.a.id === hover.id || e.b.id === hover.id);
				ctx.strokeStyle = lit ? colors.accent : colors.border;
				ctx.globalAlpha = dim ? (lit ? 0.9 : 0.25) : 0.55;
				ctx.beginPath();
				ctx.moveTo(view.panX + e.a.x * view.k, view.panY + e.a.y * view.k);
				ctx.lineTo(view.panX + e.b.x * view.k, view.panY + e.b.y * view.k);
				ctx.stroke();
			}
			ctx.globalAlpha = 1;

			// nodes + labels
			// Collect label candidates while drawing nodes; render them in a second pass
			// so higher-priority labels win collisions (below). pri: 0 = hovered/focus,
			// 1 = neighbor of the hovered node, 2 = a default hub label.
			type LabelCand = {
				n: SimNode;
				sx: number;
				sy: number;
				r: number;
				pri: number;
				near: boolean;
			};
			const labelCands: LabelCand[] = [];
			for (const n of sim) {
				const sx = view.panX + n.x * view.k;
				const sy = view.panY + n.y * view.k;
				const r = radiusOf(n);
				const isFocus = n.id === focus;
				const isHover = hover?.id === n.id;
				const near = !dim || isHover || (hi && hi.has(n.id));
				ctx.globalAlpha = near ? 1 : 0.3;
				ctx.beginPath();
				ctx.arc(sx, sy, r, 0, Math.PI * 2);
				ctx.fillStyle = isFocus || isHover ? colors.accent : `hsl(${groupHue(n.group)} 55% 55%)`;
				ctx.fill();
				if (isFocus) {
					ctx.lineWidth = 2;
					ctx.strokeStyle = colors.accent;
					ctx.globalAlpha = near ? 0.4 : 0.2;
					ctx.beginPath();
					ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
					ctx.stroke();
					ctx.globalAlpha = near ? 1 : 0.3;
				}
				const pri = isHover || isFocus ? 0 : hi && hi.has(n.id) ? 1 : hubIds.has(n.id) ? 2 : -1;
				if (pri >= 0) labelCands.push({ n, sx, sy, r, pri, near: !!near });
			}
			ctx.globalAlpha = 1;

			// Label pass: place by priority (then by degree), skipping any that would
			// overlap an already-placed label — greedy collision avoidance, so the graph
			// never clumps into overlapping text. Hovered/focus labels (pri 0) always draw.
			labelCands.sort((a, b) => a.pri - b.pri || b.n.degree - a.n.degree);
			const placed: { x: number; y: number; w: number; h: number }[] = [];
			ctx.textAlign = 'center';
			ctx.textBaseline = 'top';
			for (const c of labelCands) {
				const strong = c.pri === 0;
				ctx.font = `${strong ? 600 : 400} 11px ui-sans-serif, system-ui, sans-serif`;
				const label = c.n.title.length > 28 ? c.n.title.slice(0, 27) + '…' : c.n.title;
				const w = ctx.measureText(label).width;
				const box = { x: c.sx - w / 2 - 2, y: c.sy + c.r + 2, w: w + 4, h: 13 };
				const clash = placed.some(
					(p) =>
						box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y
				);
				if (clash && !strong) continue; // pri 0 always shows; others yield
				placed.push(box);
				ctx.globalAlpha = c.near ? 1 : 0.28;
				// A short shadow so a label stays legible over nodes/edges behind it.
				ctx.fillStyle = colors.bg;
				ctx.fillText(label, c.sx + 0.6, c.sy + c.r + 3.6);
				ctx.fillStyle = colors.fg;
				ctx.fillText(label, c.sx, c.sy + c.r + 3);
			}
			ctx.globalAlpha = 1;
		}

		// ---- canvas sizing (DPR-aware) ----
		let dpr = 1;
		function resize() {
			const rect = wrap.getBoundingClientRect();
			W = rect.width;
			H = rect.height;
			dpr = window.devicePixelRatio || 1;
			canvas.width = Math.max(1, Math.round(W * dpr));
			canvas.height = Math.max(1, Math.round(H * dpr));
			canvas.style.width = `${W}px`;
			canvas.style.height = `${H}px`;
		}

		// ---- interaction ----
		let dragNode: SimNode | null = null;
		let panning = false;
		let movedSince = 0;
		let lastX = 0,
			lastY = 0;
		const pickNode = (sx: number, sy: number): SimNode | null => {
			const w = toWorld(sx, sy);
			let best: SimNode | null = null;
			let bestD = Infinity;
			for (const n of sim) {
				const dx = n.x - w.x;
				const dy = n.y - w.y;
				const d = Math.sqrt(dx * dx + dy * dy);
				const hitR = radiusOf(n) + 6 / view.k;
				if (d < hitR && d < bestD) {
					best = n;
					bestD = d;
				}
			}
			return best;
		};
		const localPos = (e: PointerEvent) => {
			const rect = canvas.getBoundingClientRect();
			return { x: e.clientX - rect.left, y: e.clientY - rect.top };
		};

		function onDown(e: PointerEvent) {
			const p = localPos(e);
			movedSince = 0;
			lastX = p.x;
			lastY = p.y;
			canvas.setPointerCapture(e.pointerId);
			intro = false; // user took over — stop auto-framing the settle
			const n = pickNode(p.x, p.y);
			if (n) {
				dragNode = n;
				n.fixed = true;
			} else {
				panning = true;
			}
			alpha = Math.max(alpha, 0.3);
			ensureRunning();
		}
		function onMove(e: PointerEvent) {
			const p = localPos(e);
			if (dragNode) {
				const w = toWorld(p.x, p.y);
				dragNode.x = w.x;
				dragNode.y = w.y;
				movedSince += Math.abs(p.x - lastX) + Math.abs(p.y - lastY);
				alpha = Math.max(alpha, 0.3);
				ensureRunning();
			} else if (panning) {
				view.panX += p.x - lastX;
				view.panY += p.y - lastY;
				movedSince += Math.abs(p.x - lastX) + Math.abs(p.y - lastY);
				draw();
			} else {
				const n = pickNode(p.x, p.y);
				if (n !== hover) {
					hover = n;
					canvas.style.cursor = n ? 'pointer' : 'grab';
					draw();
				}
			}
			lastX = p.x;
			lastY = p.y;
		}
		function onUp(e: PointerEvent) {
			const p = localPos(e);
			try {
				canvas.releasePointerCapture(e.pointerId);
			} catch {
				/* not captured */
			}
			if (dragNode) {
				dragNode.fixed = false;
				// A tap (no real drag) on a node opens it.
				if (movedSince < 5) navigateTo(dragNode.id);
				dragNode = null;
			}
			panning = false;
			hover = pickNode(p.x, p.y);
			draw();
		}
		function onWheel(e: WheelEvent) {
			e.preventDefault();
			intro = false; // user is zooming — stop auto-framing the settle
			const rect = canvas.getBoundingClientRect();
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;
			const before = toWorld(sx, sy);
			const factor = Math.exp(-e.deltaY * 0.0015);
			view.k = Math.max(0.15, Math.min(4, view.k * factor));
			// keep the point under the cursor stationary
			view.panX = sx - before.x * view.k;
			view.panY = sy - before.y * view.k;
			draw();
		}

		// ---- animation loop (cools to rest, then idles) ----
		let raf = 0;
		let running = false;
		function frame() {
			if (alpha > 0.004) {
				tick(alpha);
				alpha *= 0.95;
				if (intro) easeFitToward();
				draw();
				raf = requestAnimationFrame(frame);
			} else {
				intro = false;
				running = false;
			}
		}
		function ensureRunning() {
			if (!running) {
				running = true;
				raf = requestAnimationFrame(frame);
			}
		}

		// ---- boot: size, then either animate the settle or (reduced-motion) render it settled ----
		resize();
		const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reduceMotion) {
			// Accessibility: no intro. Converge synchronously and paint the final layout.
			for (let i = 0; i < 140; i++) tick(1 - i / 200);
			fit();
			draw();
		} else {
			// Obsidian-style live settle: start the nodes in a tight cluster (~⅓ of the
			// settled scale) so repulsion visibly springs them apart, then run the cooling
			// loop from boot. easeFitToward() pulls the camera out as the graph blooms so
			// it stays framed. The seed is deterministic (no Math.random here).
			for (let i = 0; i < sim.length; i++) {
				const n = sim[i];
				const a = (i / sim.length) * Math.PI * 2;
				const r = (40 + (i % 7) * 24) * 0.35;
				n.x = Math.cos(a) * r;
				n.y = Math.sin(a) * r;
				n.vx = 0;
				n.vy = 0;
			}
			fit(); // frame the tight cluster; auto-fit zooms out as it spreads
			alpha = 1;
			intro = true;
			draw();
			ensureRunning();
		}

		const ro = new ResizeObserver(() => {
			const prevW = W;
			resize();
			if (prevW === 0 && W > 0) fit(); // first real size — frame whatever's on screen now
			draw();
		});
		ro.observe(wrap);

		// Re-read palette when the host flips theme (data-theme) or the OS scheme changes.
		const mo = new MutationObserver(() => {
			colors = readGraphColors();
			draw();
		});
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
		const mq = matchMedia('(prefers-color-scheme: dark)');
		const onScheme = () => {
			colors = readGraphColors();
			draw();
		};
		mq.addEventListener('change', onScheme);

		canvas.addEventListener('pointerdown', onDown);
		canvas.addEventListener('pointermove', onMove);
		canvas.addEventListener('pointerup', onUp);
		canvas.addEventListener('wheel', onWheel, { passive: false });
		canvas.style.cursor = 'grab';

		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
			mo.disconnect();
			mq.removeEventListener('change', onScheme);
			canvas.removeEventListener('pointerdown', onDown);
			canvas.removeEventListener('pointermove', onMove);
			canvas.removeEventListener('pointerup', onUp);
			canvas.removeEventListener('wheel', onWheel);
		};
	}, [nodes, links, focus]);

	if (!nodes.length) {
		return (
			<div class="mt-10 text-center text-muted">
				<p>Nothing to graph yet.</p>
				<p class="mt-1 text-sm">
					Create a few linked pages and they’ll show up here as a connected map.
				</p>
			</div>
		);
	}

	// No heading or inner box: the header crumb carries the "Graph" title and the app
	// card is the only frame. The canvas sits directly on the card. The page/link
	// tally belongs to the graph, not the nav, so it sits in the canvas's bottom-right
	// corner as faint borderless text (inert — pointer events pass through to the
	// canvas so it can't block a drag).
	return (
		<div>
			<div
				ref={wrapRef}
				class="relative w-full overflow-hidden"
				style={{ height: tall ? '72vh' : '420px' }}
			>
				<canvas ref={canvasRef} class="block h-full w-full touch-none" />
				<span class="pointer-events-none absolute right-1 bottom-1 text-xs text-muted tabular-nums select-none">
					{nodes.length} pages · {links.length} links
				</span>
			</div>
			{truncated && (
				<p class="mt-2 text-xs text-muted">
					This brain is large; only part of it was scanned, so some pages and links may be missing.
				</p>
			)}
		</div>
	);
}

export { GraphView, readGraphColors, groupHue };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		graph: { nodes: GraphNode[]; links: GraphLink[]; focus?: string; truncated?: boolean };
	}
}

export default defineView('graph', (v) => (
	<GraphView nodes={v.nodes} links={v.links} focus={v.focus} truncated={v.truncated} />
));
