// The org role vocabulary and its picker, shared by the Members roster (changing
// someone's role in place) and the Invite flow (choosing the role to invite at).
//
// It lives here rather than in MembersView because a flow view importing a list view
// to borrow one control is how two screens end up disagreeing about what the roles
// are called. One definition, imported by both.
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

/** What each assignable role can do, for surfaces with room to say so. */
export const ROLE_BLURB: Record<MemberRole, string> = {
	viewer: 'Can read the brain.',
	editor: 'Can read the brain and write pages.',
	admin: 'Can also manage members and brains.',
	owner: 'Full control of the organization.'
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
