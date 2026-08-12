import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { closeDb, getDb } from './client.js';
import { logger } from '../shared/logger.js';

/**
 * Migrationen laufen beim Deploy mit — Schemaaenderungen werden nie von Hand
 * auf einer laufenden Datenbank vorgenommen.
 */
export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
}

const isEntrypoint = process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js');

if (isEntrypoint) {
  runMigrations()
    .then(async () => {
      logger.info('Migrationen abgeschlossen');
      await closeDb();
    })
    .catch(async (error) => {
      logger.error({ err: error }, 'Migration fehlgeschlagen');
      await closeDb();
      process.exit(1);
    });
}
