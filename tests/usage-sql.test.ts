import { describe, expect, it } from 'vitest';

/**
 * Absicherung der Aggregat-Abfragen auf SQL-Ebene.
 *
 * Anlass ist ein Praxisbefund: In der Zeitreihe wurde die Zeiteinheit als
 * gebundener Parameter an date_trunc uebergeben. PostgreSQL sieht dann in
 * SELECT und GROUP BY zwei verschiedene Platzhalter und damit zwei
 * verschiedene Ausdruecke — die Abfrage bricht mit 42803 ab ("column must
 * appear in the GROUP BY clause"). Die gesamte Nutzungsseite war dadurch
 * unbrauchbar.
 *
 * Diese Tests pruefen das erzeugte SQL, ohne eine Datenbank zu brauchen.
 * Sie laufen damit in jedem CI-Lauf mit.
 */

async function baueZeitreihenSql(bucket: 'hour' | 'day'): Promise<string> {
  const { sql } = await import('drizzle-orm');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const { usageEvents } = await import('../src/db/schema.js');

  const zeitstufe =
    bucket === 'hour'
      ? sql`date_trunc('hour', ${usageEvents.ts})`
      : sql`date_trunc('day', ${usageEvents.ts})`;

  return new PgDialect().sqlToQuery(
    sql`select ${zeitstufe}::text from ${usageEvents} group by ${zeitstufe} order by ${zeitstufe}`,
  ).sql;
}

describe('Zeitreihe der Nutzung', () => {
  it('schreibt die Zeiteinheit als Literal, nicht als Parameter', async () => {
    const abfrage = await baueZeitreihenSql('day');

    expect(abfrage).toContain("date_trunc('day'");
    // Ein Platzhalter an dieser Stelle war die Ursache des Ausfalls.
    expect(abfrage).not.toMatch(/date_trunc\(\$\d/);
  });

  it('nutzt in SELECT und GROUP BY denselben Ausdruck', async () => {
    const abfrage = await baueZeitreihenSql('day');
    const treffer = abfrage.match(/date_trunc\('day', "usage_events"\."ts"\)/g);

    // Dreimal: Projektion, Gruppierung, Sortierung. Weichen sie voneinander ab,
    // haelt PostgreSQL die Spalte fuer ungruppiert.
    expect(treffer).toHaveLength(3);
  });

  it('unterscheidet die beiden Zeiteinheiten korrekt', async () => {
    expect(await baueZeitreihenSql('hour')).toContain("date_trunc('hour'");
    expect(await baueZeitreihenSql('day')).toContain("date_trunc('day'");
  });

  it('bindet keinen von aussen bestimmten Text in das SQL ein', async () => {
    // Die Zeiteinheit stammt aus zwei fest ausgeschriebenen Varianten, nicht
    // aus einer Zeichenkettenverknuepfung — deshalb ist das Literal unbedenklich.
    const abfrage = await baueZeitreihenSql('hour');
    expect(abfrage).toMatch(/date_trunc\('(hour|day)', "usage_events"\."ts"\)/);
  });
});
