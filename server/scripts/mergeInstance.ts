import dataSource from '@server/datasource';
import type { MergeSummary } from '@server/lib/instanceMerge';
import { mergeInstance } from '@server/lib/instanceMerge';
import { Command } from 'commander';
import path from 'path';
import type { DataSourceOptions } from 'typeorm';
import { DataSource } from 'typeorm';

/**
 * Merges another Seerr instance's database into this one, for installs that
 * ran a separate instance per media server before Seerr could connect to
 * several at once.
 *
 * Stop this instance before running it, point --source at a *copy* of the
 * other instance's database, and take a backup of this one first. The merge
 * runs as a dry run until --apply is passed.
 */

const isPostgresUrl = (value: string) =>
  value.startsWith('postgres://') || value.startsWith('postgresql://');

const migrationGlobs = (type: 'sqlite' | 'postgres'): string[] =>
  process.env.NODE_ENV === 'production'
    ? [`dist/migration/${type}/**/*.js`]
    : [`server/migration/${type}/**/*.ts`];

const buildSourceOptions = (
  source: string,
  migrateSource: boolean
): DataSourceOptions => {
  const shared = {
    name: 'merge-source',
    synchronize: false,
    migrationsRun: migrateSource,
    logging: false,
    entities: dataSource.options.entities,
    // The merge only reads, so nothing here should react to it.
    subscribers: [],
  };

  if (isPostgresUrl(source)) {
    return {
      ...shared,
      type: 'postgres',
      url: source,
      migrations: migrationGlobs('postgres'),
    } as DataSourceOptions;
  }

  return {
    ...shared,
    type: 'sqlite',
    database: source,
    migrations: migrationGlobs('sqlite'),
  } as DataSourceOptions;
};

const formatCounts = (label: string, counts: MergeSummary['users']) =>
  `  ${label.padEnd(15)} created ${String(counts.created).padStart(
    6
  )}   updated ${String(counts.updated).padStart(6)}   unchanged ${String(
    counts.skipped
  ).padStart(6)}`;

const printSummary = (summary: MergeSummary) => {
  // eslint-disable-next-line no-console
  const write = console.log;

  write('');
  write(
    summary.applied
      ? 'Merge complete.'
      : 'Dry run complete. Nothing was written. Re-run with --apply to keep these changes.'
  );
  write('');
  write(formatCounts('Users', summary.users));
  write(formatCounts('Media', summary.media));
  write(formatCounts('Seasons', summary.seasons));
  write(formatCounts('Requests', summary.requests));
  write(formatCounts('Issues', summary.issues));
  write(formatCounts('Issue comments', summary.issueComments));
  write(formatCounts('Watchlists', summary.watchlists));
  write(formatCounts('Blocklist', summary.blocklist));

  if (summary.warnings.length > 0) {
    write('');
    write(`Warnings (${summary.warnings.length}):`);
    for (const warning of summary.warnings) {
      write(`  - ${warning}`);
    }
  }

  write('');
};

const run = async () => {
  const program = new Command();

  program
    .name('merge-instance')
    .description(
      "Merge another Seerr instance's database into this one. Stop Seerr and back up its database first."
    )
    .requiredOption(
      '-s, --source <path|url>',
      "Path to a copy of the other instance's SQLite database, or a postgres:// URL"
    )
    .option(
      '--apply',
      'Write the merge. Without this the merge is rolled back and only reported.',
      false
    )
    .option(
      '--keep-permissions',
      'Give merged users the permissions they held on the other instance (admin rights are never carried over).',
      false
    )
    .option(
      '--migrate-source',
      'Bring the source database up to the current schema first. Only use this against a copy.',
      false
    )
    .parse();

  const opts = program.opts<{
    source: string;
    apply: boolean;
    keepPermissions: boolean;
    migrateSource: boolean;
  }>();

  const destinationOptions = {
    ...dataSource.options,
    name: 'merge-destination',
    synchronize: false,
    migrationsRun: false,
    // Merging must not trigger *arr pushes or notifications.
    subscribers: [],
  } as DataSourceOptions;

  if (
    !isPostgresUrl(opts.source) &&
    destinationOptions.type === 'sqlite' &&
    typeof destinationOptions.database === 'string' &&
    path.resolve(opts.source) === path.resolve(destinationOptions.database)
  ) {
    throw new Error(
      'The source and destination are the same database. Point --source at the other instance.'
    );
  }

  const source = new DataSource(
    buildSourceOptions(opts.source, opts.migrateSource)
  );
  const destination = new DataSource(destinationOptions);

  await source.initialize();
  await destination.initialize();

  try {
    const summary = await mergeInstance({
      source,
      destination,
      apply: opts.apply,
      keepPermissions: opts.keepPermissions,
      // eslint-disable-next-line no-console
      log: (message) => console.log(message),
    });

    printSummary(summary);
  } finally {
    await source.destroy();
    await destination.destroy();
  }
};

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`Merge failed: ${e.message}`);
  process.exit(1);
});
