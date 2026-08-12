import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { getConfig } from '../shared/config.js';

export type Database = ReturnType<typeof createDatabase>;

let sql: ReturnType<typeof postgres> | undefined;
let db: ReturnType<typeof drizzle<typeof schema>> | undefined;

function createDatabase(connectionString: string) {
  sql = postgres(connectionString, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // Item-Inhalte und Credentials duerfen nie in einem Query-Log landen.
    onnotice: () => {},
  });
  return drizzle(sql, { schema });
}

export function getDb() {
  db ??= createDatabase(getConfig().DATABASE_URL);
  return db;
}

export async function closeDb(): Promise<void> {
  await sql?.end({ timeout: 5 });
  sql = undefined;
  db = undefined;
}

/** Einfacher Verfuegbarkeitstest fuer den Health-Endpunkt. */
export async function pingDb(): Promise<boolean> {
  try {
    const client = getDb();
    await client.execute('select 1');
    return true;
  } catch {
    return false;
  }
}

export { schema };
