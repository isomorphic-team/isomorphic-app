// ---------- analytics view ----------
//
// The organization's usage: how many members were active, reads and edits over
// time, a per-brain breakdown, and (for admins) a per-person table.
//
// WHY TWO SEPARATE BAR ROWS AND NOT ONE STACKED CHART. Reads outnumber edits by an
// order of magnitude in every real brain, so a shared scale renders the edit
// segment at sub-pixel height: the series that answers "is anyone maintaining
// this?" would be the invisible one. Two small multiples, each scaled to its own
// max (labelled, so they are never mistaken for a common axis), keep both legible.
// It also removes the two-series colour problem entirely: one series per row means
// identity comes from the row's own heading rather than from a hue, so there is no
// categorical palette to get wrong and no legend to carry.
//
// A ZERO DAY IS NOT A MISSING DAY. Empty days render a baseline tick rather than
// nothing, and any non-zero day gets a minimum height, so one call never rounds
// away to an apparently idle day.

import type {
	UsageWindow,
	UsageTotals,
	UsagePoint,
	UsagePerson,
	UsageBrain
} from '../core/types.ts';
import { useState } from 'preact/hooks';
import { openAnalytics } from '../core/actions.ts';
import { relativeTime } from '../core/util.ts';
import { InitialsAvatar } from '../core/icons.tsx';
import { defineView } from '../core/view-registry.ts';
import { List, ListRow } from '../ui/index.ts';
import { eyebrow } from '../ui/typography.ts';

const RANGES = [7, 30, 90];

// No `hint` line. It read "Active / 7 of 24 / members", where the third line was the
// first line's noun: the label carries it instead.
function StatTile({ label, value }: { label: string; value: string }) {
	return (
		<div class="rounded-md border border-border px-3 py-2">
			<div class={eyebrow}>{label}</div>
			<div class="mt-0.5 text-xl font-semibold tabular-nums text-fg">{value}</div>
		</div>
	);
}

// One small multiple: a day-by-day bar row for a single measure.
//
// The row states its PEAK and not its total. The total sits in the tile directly
// above this, so printing it here was the same number twice, six inches apart; the
// peak is the one fact the row alone can tell you, because it is what the bar
// heights are relative to and the two rows do not share a scale.
//
// `axis` is drawn by the LAST row only. The rows are the same 30 days, so a
// from/to pair under each was one date axis rendered twice.
function BarRow({
	label,
	points,
	pick,
	axis
}: {
	label: string;
	points: UsagePoint[];
	pick: (p: UsagePoint) => number;
	axis?: boolean;
}) {
	const max = Math.max(1, ...points.map(pick));
	const total = points.reduce((n, p) => n + pick(p), 0);
	const [hover, setHover] = useState<number | null>(null);
	return (
		<div class="mt-4">
			<div class="flex items-baseline justify-between">
				<div class={eyebrow}>{label}</div>
				<div class="text-xs tabular-nums text-muted">peak {max.toLocaleString()}/day</div>
			</div>
			<div class="relative">
				<div
					class="mt-1.5 flex h-16 items-stretch gap-[2px]"
					role="img"
					aria-label={`${label}: ${total} over ${points.length} days`}
					onMouseLeave={() => setHover(null)}
				>
					{points.map((p, i) => {
						const v = pick(p);
						// Non-zero always shows: 8% floor keeps a single call visible, and a
						// zero day keeps a 1px tick so the day itself is never missing.
						const pct = v === 0 ? 0 : Math.max(8, Math.round((v / max) * 100));
						return (
							// THE HIT TARGET IS THE FULL COLUMN, not the bar. The bar's height is
							// its value, so making the bar the target meant a quiet day was a 4px
							// sliver and a zero day was 1px: hover appeared to work on tall bars
							// and to be broken everywhere else. The column is always 64px tall.
							<div
								key={p.day}
								class={`flex flex-1 items-end rounded-sm ${hover === i ? 'bg-chip' : ''}`}
								onMouseEnter={() => setHover(i)}
							>
								<div
									class="w-full rounded-t-[4px]"
									style={{
										height: v === 0 ? '1px' : `${pct}%`,
										background: v === 0 ? 'var(--c-border)' : 'var(--c-accent)'
									}}
								/>
							</div>
						);
					})}
				</div>
				{/* A real tooltip rather than the native `title`, which waits ~1s, hides
				    itself after a few seconds, and will not re-fire as you sweep sideways
				    across adjacent bars — the "works sometimes" behaviour. Clamped away from
				    both edges so the first and last day do not render off the card. */}
				{hover !== null && (
					<div
						class="pointer-events-none absolute z-10 whitespace-nowrap rounded border border-border bg-bg px-1.5 py-0.5 text-2xs text-fg shadow-sm"
						style={{
							bottom: '100%',
							left: `${Math.min(92, Math.max(8, ((hover + 0.5) / points.length) * 100))}%`,
							transform: 'translateX(-50%)'
						}}
					>
						{points[hover].day} · {pick(points[hover]).toLocaleString()} {label.toLowerCase()}
					</div>
				)}
			</div>
			{axis && (
				<div class="mt-1 flex justify-between text-2xs text-muted">
					<span>{points[0]?.day ?? ''}</span>
					<span>{points[points.length - 1]?.day ?? ''}</span>
				</div>
			)}
		</div>
	);
}

function AnalyticsView({
	orgName,
	totals,
	series,
	people,
	brains,
	canSeePeople,
	truncated,
	footnote
}: {
	orgName: string;
	totals: UsageTotals;
	series: UsagePoint[];
	people: UsagePerson[];
	brains: UsageBrain[];
	canSeePeople: boolean;
	truncated: boolean;
	footnote: string;
}) {
	return (
		<div>
			{/* Org only. "· last 30 days" used to sit here too, and the lit 30d button in
			    the header now says that, so it was a caption restating a control. */}
			<div class="mb-3 text-sm text-muted">{orgName}</div>

			{truncated && (
				<div class="mb-3 rounded-md border border-border bg-chip px-3 py-2 text-xs text-muted">
					More activity than one report can hold. These numbers cover the most recent portion of the
					window only.
				</div>
			)}

			{/* THREE TILES, not four. The fourth was "Brains used — 1 of 1", which is
			    the shape most orgs have and says nothing; where it did say something
			    (2+ brains) the By-brain table below says it better, per brain. */}
			<div class="grid grid-cols-3 gap-2">
				{/* The adoption number leads. It is the one figure on this page that
				    someone can act on, and "of N" is what makes it mean anything. */}
				<StatTile label="Active members" value={`${totals.activeUsers} of ${totals.members}`} />
				<StatTile label="Reads" value={totals.reads.toLocaleString()} />
				<StatTile label="Edits" value={totals.writes.toLocaleString()} />
			</div>

			<BarRow label="Reads" points={series} pick={(p) => p.reads} />
			<BarRow label="Edits" points={series} pick={(p) => p.writes} axis />

			{/* Only worth a section when there is a comparison to draw. With one brain
			    every cell in it repeats a tile above, down to the person count. */}
			{brains.length > 1 && (
				<div class="mt-6">
					<div class={`mb-1.5 ${eyebrow}`}>By brain</div>
					<List>
						{brains.map((b) => (
							<ListRow key={b.brain_id}>
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm text-fg" title={b.brain_id}>
										{b.label}
									</div>
									<div class="text-xs text-muted">
										{b.lastActive
											? `${b.people} ${b.people === 1 ? 'person' : 'people'} · last active ${relativeTime(b.lastActive)}`
											: 'No activity in this window'}
									</div>
								</div>
								<span class="shrink-0 text-sm tabular-nums text-muted">
									{b.reads.toLocaleString()} r · {b.writes.toLocaleString()} e
								</span>
							</ListRow>
						))}
					</List>
				</div>
			)}

			<div class="mt-6">
				<div class={`mb-1.5 ${eyebrow}`}>By person</div>
				{canSeePeople ? (
					<List>
						{people.map((p) => {
							const who = p.name || p.email || 'Removed member';
							return (
								<ListRow key={p.user_id}>
									<InitialsAvatar name={who} />
									<div class="min-w-0 flex-1">
										<div class="flex items-baseline gap-2">
											<span class="truncate text-sm text-fg" title={p.email ?? undefined}>
												{who}
											</span>
											{p.former && (
												<span
													class="shrink-0 text-2xs text-muted"
													title="No longer in this organization — their activity still counts toward the totals above"
												>
													Removed
												</span>
											)}
										</div>
										{/* An inactive member is the actionable row, so it says so in
										    words rather than leaving the reader to parse two zeroes. */}
										<div class="text-xs text-muted">
											{p.lastActive ? `Last active ${relativeTime(p.lastActive)}` : 'Never active'}
										</div>
									</div>
									<span class="shrink-0 text-sm tabular-nums text-muted">
										{p.reads.toLocaleString()} r · {p.writes.toLocaleString()} e
									</span>
								</ListRow>
							);
						})}
					</List>
				) : (
					// Withheld, not empty. The server never sent these rows, and saying which
					// it is stops the tab reading as "nobody in your org has used this".
					// One muted line: a bordered card gave a one-sentence aside the same
					// visual weight as the data it stands in for.
					<div class="text-sm text-muted">
						Per-person activity is visible to organization admins.
					</div>
				)}
			</div>

			<div class="mt-4 text-xs text-muted">{footnote}</div>
		</div>
	);
}

export { AnalyticsView };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		analytics: {
			orgName: string;
			window: UsageWindow;
			totals: UsageTotals;
			series: UsagePoint[];
			people: UsagePerson[];
			brains: UsageBrain[];
			canSeePeople: boolean;
			truncated: boolean;
			footnote: string;
		};
	}
}

export default defineView(
	'analytics',
	(v) => (
		<AnalyticsView
			orgName={v.orgName}
			totals={v.totals}
			series={v.series}
			people={v.people}
			brains={v.brains}
			canSeePeople={v.canSeePeople}
			truncated={v.truncated}
			footnote={v.footnote}
		/>
	),
	{
		// The time range is the only control this view has, and it belongs in the
		// header's "what you can do HERE" slot rather than as a widget in the body.
		actions: (v) =>
			RANGES.map((d) => ({
				key: `range-${d}`,
				label: `${d}d`,
				title: `Last ${d} days`,
				active: v.window.days === d,
				onClick: () => openAnalytics(d)
			}))
	}
);
