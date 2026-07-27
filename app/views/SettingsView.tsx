import type { Identity, ConnectedAccount } from '../core/types.ts';
import { InitialsAvatar, LinkIcon } from '../core/icons.tsx';
import { ConnectedAccountsSection } from '../components/ConnectedAccountsSection.tsx';
import { defineView } from '../core/view-registry.ts';

// The user's own settings. Today it's the signed-in identity card; it's the extensible
// slot where future personal rows (Connected accounts, notifications, Org settings) land.
// Uses the same avatar + two-line pattern as the members/activity rosters.
function SettingsView({
	identity,
	accounts
}: {
	identity: Identity;
	accounts: ConnectedAccount[];
}) {
	const primary = identity.email ?? (identity.login ? `@${identity.login}` : 'Signed in');
	// Role in the active brain + the org that owns it, when the product-native path
	// resolved them (static-bearer / unresolved sessions just show the identity).
	const parts = [
		identity.role && roleTitle(identity.role),
		identity.org && `@${identity.org}`
	].filter(Boolean);
	return (
		<div>
			<div class="flex items-center gap-3 py-2.5">
				<InitialsAvatar name={primary} />
				<div class="min-w-0 flex-1">
					<div class="truncate font-medium text-fg" title={primary}>
						{primary}
					</div>
					{parts.length > 0 && <div class="truncate text-xs text-muted">{parts.join(' · ')}</div>}
				</div>
			</div>
			<div class="mt-5">
				<div class="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
					<LinkIcon />
					Connected accounts
				</div>
				<ConnectedAccountsSection initial={accounts} />
			</div>
		</div>
	);
}

// Capitalize a role token for display (viewer → Viewer). Mirrors ROLE_LABEL without
// forcing Identity.role into the MemberRole union (whoami may report any role string).
function roleTitle(role: string): string {
	return role.charAt(0).toUpperCase() + role.slice(1);
}

export { SettingsView, roleTitle };

declare module '../core/view-registry.ts' {
	interface ViewProps {
		settings: { identity: Identity; accounts: ConnectedAccount[] };
	}
}

export default defineView('settings', (v) => (
	<SettingsView identity={v.identity} accounts={v.accounts} />
));
