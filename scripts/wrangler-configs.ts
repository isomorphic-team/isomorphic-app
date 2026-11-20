// The Wrangler configs `pnpm setup:config` generates, each from its committed template,
// and the optional blocks each keeps only when a setting is filled. Everything that treats
// the generated files specially (setup-config, the agent hooks, test:docs, doctor) reads
// this list. No imports: the PreToolUse hook loads it under plain `node`.

export interface WranglerConfig {
	template: string;
	output: string;
	// `// <name>:start` ... `// <name>:end` in the template, kept when `setting` is non-empty.
	blocks: { name: string; setting: string }[];
}

export const WRANGLER_CONFIGS: WranglerConfig[] = [
	{
		template: 'wrangler.template.jsonc',
		output: 'wrangler.jsonc',
		blocks: [{ name: 'index-db', setting: 'CF_INDEX_D1_DATABASE_ID' }]
	},
	{
		template: 'wrangler.objects.template.jsonc',
		output: 'wrangler.objects.jsonc',
		blocks: [{ name: 'backups', setting: 'BACKUP_BUCKET' }]
	}
];

export const GENERATED_CONFIGS = WRANGLER_CONFIGS.map((c) => c.output);
