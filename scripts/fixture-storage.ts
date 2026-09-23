// Storage connections for hand-written test fixtures.
//
// A fixture writes orgs and brains as rows; production gives each org a default
// connection (createOrg) and each brain a binding (create_brain, connect_brain), and
// migrations 0010 and 0013 did the same for the rows that predate them. These
// statements do exactly that backfill over whatever the fixture wrote, so a fixture
// states who can reach what and stays silent about storage unless storage is its
// subject. A brain without a binding is not listed (listAccessibleBrains).

export const BIND_FIXTURE_STORAGE: readonly string[] = [
	`INSERT OR IGNORE INTO storage_connections
	   (connection_id, provider, kind, external_id, account, owner_org_id)
	 SELECT 'github-app:' || installation_id, 'github', 'github-app-installation',
	        CAST(installation_id AS TEXT), brain_owner,
	        CASE WHEN model = 'customer' THEN org_id END
	   FROM orgs ORDER BY created_at, org_id`,
	`UPDATE orgs SET default_connection_id = 'github-app:' || installation_id
	  WHERE default_connection_id IS NULL`,
	`UPDATE brains
	    SET storage_connection_id =
	        (SELECT 'github-app:' || o.installation_id FROM orgs o WHERE o.org_id = brains.org_id)
	  WHERE storage_connection_id IS NULL`
];

export function bindFixtureStorage(sqlite: { exec(sql: string): void }): void {
	for (const sql of BIND_FIXTURE_STORAGE) sqlite.exec(sql);
}
