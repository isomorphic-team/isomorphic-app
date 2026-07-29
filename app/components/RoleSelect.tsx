// The role vocabulary and its picker, shared by the Members roster (changing someone's
// role in place), the Invite flow (choosing the role to invite at), and the per-brain
// sharing surfaces.
//
// It lives here rather than in MembersView because a flow view importing a list view
// to borrow one control is how two screens end up disagreeing about what the roles
// are called. One definition, imported by all four.
//
// The NAMES are shared across both scopes; the BLURBS are not. A brain admin can
// share that one brain, an org admin can manage the whole roster. Describing them
// with one string would tell someone being granted brain-admin that they are getting
// the org. See docs/design/brain-level-permissions.md.
import type { MemberRole } from '../core/types.ts';
import { Select } from '../ui/index.ts';

export const ROLE_LABEL: Record<MemberRole, string> = {
	viewer: 'Viewer',
	editor: 'Editor',
	admin: 'Admin',
	owner: 'Owner'
};

// The roles an admin can assign in the UI (owner is never offered — see members.ts).
export const ASSIGNABLE_ROLES: MemberRole[] = ['viewer', 'editor', 'admin'];

/** What each assignable ORG role can do, for surfaces with room to say so. */
export const ROLE_BLURB: Record<MemberRole, string> = {
	viewer: 'Can read the brain.',
	editor: 'Can read the brain and write pages.',
	admin: 'Can also manage members and brains.',
	owner: 'Full control of the organization.'
};

/** The same roles scoped to ONE brain: what a share actually grants. */
export const BRAIN_ROLE_BLURB: Record<MemberRole, string> = {
	viewer: 'Can read this brain.',
	editor: 'Can read this brain and write pages.',
	admin: 'Can also change who else can reach it.',
	owner: 'Full control of this brain.'
};

// Compact role picker used for both inviting and changing a role. Native <select>
// so it's keyboard/host accessible; styled to sit quietly in the row.
export function RoleSelect({
	value,
	disabled,
	onChange
}: {
	value: MemberRole;
	disabled?: boolean;
	onChange: (r: MemberRole) => void;
}) {
	return (
		<Select
			value={value}
			disabled={disabled}
			aria-label="Role"
			onChange={(e) => onChange((e.target as HTMLSelectElement).value as MemberRole)}
			class="shrink-0 py-1 pl-2 pr-1"
		>
			{ASSIGNABLE_ROLES.map((r) => (
				<option key={r} value={r}>
					{ROLE_LABEL[r]}
				</option>
			))}
		</Select>
	);
}
