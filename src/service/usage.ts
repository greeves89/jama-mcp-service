import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { auditLog, usageEvents } from '../db/schema.js';
import { logger } from '../shared/logger.js';
import type { ToolInvocationRecord } from '../mcp/server.js';
import type { AuditIntent } from '../mcp/types.js';

/**
 * Schreiben und Auswerten von Nutzungs- und Audit-Daten.
 *
 * Beide Schreibpfade sind bewusst fehlertolerant: geht die Protokollierung
 * schief, darf der eigentliche Tool-Aufruf trotzdem gelingen. Ein verlorener
 * Statistikeintrag ist ein kleineres Uebel als ein abgebrochener Schreibvorgang
 * in Jama, der halb ausgefuehrt zurueckbleibt.
 */

export async function recordUsage(
  record: ToolInvocationRecord,
  key: { id?: string; name: string },
): Promise<void> {
  try {
    await getDb()
      .insert(usageEvents)
      .values({
        apiKeyId: key.id ?? null,
        apiKeyName: key.name,
        toolName: record.toolName,
        toolset: record.toolset,
        projectId: record.projectId ?? null,
        durationMs: record.durationMs,
        status: record.status,
        errorCode: record.errorCode ?? null,
        jamaCallCount: record.jamaCalls,
        cacheHits: record.cacheHits,
        retries: record.retries,
        responseBytes: record.responseBytes,
        estTokens: record.estTokens,
        truncated: record.truncated,
      });
  } catch (error) {
    logger.error({ err: error, tool: record.toolName }, 'Nutzungsereignis konnte nicht gespeichert werden');
  }
}

export async function recordAudit(
  entry: AuditIntent,
  actor: { type: 'api_key' | 'admin' | 'system'; id?: string; name?: string; ip?: string },
): Promise<void> {
  try {
    await getDb()
      .insert(auditLog)
      .values({
        actorType: actor.type,
        actorId: actor.id ?? null,
        actorName: actor.name ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetKey: entry.targetKey ?? null,
        payload: entry.payload ?? null,
        result: entry.result,
        message: entry.message ?? null,
        ip: actor.ip ?? null,
      });
  } catch (error) {
    logger.error({ err: error, action: entry.action }, 'Audit-Eintrag konnte nicht gespeichert werden');
  }
}

export interface UsageFilter {
  from?: Date;
  to?: Date;
  apiKeyId?: string;
  toolName?: string;
}

function conditions(filter: UsageFilter) {
  const parts = [];
  if (filter.from) parts.push(gte(usageEvents.ts, filter.from));
  if (filter.to) parts.push(lt(usageEvents.ts, filter.to));
  if (filter.apiKeyId) parts.push(eq(usageEvents.apiKeyId, filter.apiKeyId));
  if (filter.toolName) parts.push(eq(usageEvents.toolName, filter.toolName));
  return parts.length > 0 ? and(...parts) : undefined;
}

export interface UsageSummary {
  aufrufe: number;
  fehler: number;
  fehlerquote: number;
  jamaAufrufe: number;
  cacheTreffer: number;
  cacheTrefferquote: number;
  wiederholungen: number;
  geschaetzteToken: number;
  latenzP50: number;
  latenzP95: number;
  latenzP99: number;
}

export async function usageSummary(filter: UsageFilter): Promise<UsageSummary> {
  const where = conditions(filter);

  const rows = await getDb()
    .select({
      aufrufe: sql<number>`count(*)::int`,
      fehler: sql<number>`count(*) filter (where ${usageEvents.status} = 'error')::int`,
      jamaAufrufe: sql<number>`coalesce(sum(${usageEvents.jamaCallCount}), 0)::int`,
      cacheTreffer: sql<number>`coalesce(sum(${usageEvents.cacheHits}), 0)::int`,
      wiederholungen: sql<number>`coalesce(sum(${usageEvents.retries}), 0)::int`,
      token: sql<number>`coalesce(sum(${usageEvents.estTokens}), 0)::int`,
      p50: sql<number>`coalesce(percentile_disc(0.5) within group (order by ${usageEvents.durationMs}), 0)::int`,
      p95: sql<number>`coalesce(percentile_disc(0.95) within group (order by ${usageEvents.durationMs}), 0)::int`,
      p99: sql<number>`coalesce(percentile_disc(0.99) within group (order by ${usageEvents.durationMs}), 0)::int`,
    })
    .from(usageEvents)
    .where(where);

  const row = rows[0];
  const aufrufe = row?.aufrufe ?? 0;
  const fehler = row?.fehler ?? 0;
  const cacheTreffer = row?.cacheTreffer ?? 0;
  const jamaAufrufe = row?.jamaAufrufe ?? 0;
  const zugriffe = cacheTreffer + jamaAufrufe;

  return {
    aufrufe,
    fehler,
    fehlerquote: aufrufe === 0 ? 0 : Math.round((fehler / aufrufe) * 1000) / 10,
    jamaAufrufe,
    cacheTreffer,
    cacheTrefferquote: zugriffe === 0 ? 0 : Math.round((cacheTreffer / zugriffe) * 1000) / 10,
    wiederholungen: row?.wiederholungen ?? 0,
    geschaetzteToken: row?.token ?? 0,
    latenzP50: row?.p50 ?? 0,
    latenzP95: row?.p95 ?? 0,
    latenzP99: row?.p99 ?? 0,
  };
}

/**
 * Zeitreihe fuer die Diagramme im Dashboard.
 *
 * Die Zeiteinheit muss als Literal im SQL stehen: date_trunc erwartet dort
 * keinen gebundenen Parameter, weil PostgreSQL dessen Typ nicht bestimmen kann
 * und die Abfrage mit einem Fehler abbricht. Statt den Wert in den SQL-Text zu
 * kleben, wird zwischen zwei fest ausgeschriebenen Varianten gewaehlt — damit
 * gelangt kein von aussen bestimmter Text in die Abfrage.
 */
export async function usageTimeline(
  filter: UsageFilter,
  bucket: 'hour' | 'day',
): Promise<Array<{ zeitpunkt: string; aufrufe: number; fehler: number; token: number }>> {
  const zeitstufe =
    bucket === 'hour'
      ? sql`date_trunc('hour', ${usageEvents.ts})`
      : sql`date_trunc('day', ${usageEvents.ts})`;

  const rows = await getDb()
    .select({
      zeitpunkt: sql<string>`${zeitstufe}::text`,
      aufrufe: sql<number>`count(*)::int`,
      fehler: sql<number>`count(*) filter (where ${usageEvents.status} = 'error')::int`,
      token: sql<number>`coalesce(sum(${usageEvents.estTokens}), 0)::int`,
    })
    .from(usageEvents)
    .where(conditions(filter))
    .groupBy(zeitstufe)
    .orderBy(zeitstufe);

  return rows;
}

export async function topTools(
  filter: UsageFilter,
  limit = 10,
): Promise<Array<{ tool: string; aufrufe: number; fehler: number; token: number; p95: number }>> {
  return getDb()
    .select({
      tool: usageEvents.toolName,
      aufrufe: sql<number>`count(*)::int`,
      fehler: sql<number>`count(*) filter (where ${usageEvents.status} = 'error')::int`,
      token: sql<number>`coalesce(sum(${usageEvents.estTokens}), 0)::int`,
      p95: sql<number>`coalesce(percentile_disc(0.95) within group (order by ${usageEvents.durationMs}), 0)::int`,
    })
    .from(usageEvents)
    .where(conditions(filter))
    .groupBy(usageEvents.toolName)
    .orderBy(sql`count(*) desc`)
    .limit(limit);
}

export async function topKeys(
  filter: UsageFilter,
  limit = 10,
): Promise<Array<{ zugang: string | null; aufrufe: number; token: number }>> {
  return getDb()
    .select({
      zugang: usageEvents.apiKeyName,
      aufrufe: sql<number>`count(*)::int`,
      token: sql<number>`coalesce(sum(${usageEvents.estTokens}), 0)::int`,
    })
    .from(usageEvents)
    .where(conditions(filter))
    .groupBy(usageEvents.apiKeyName)
    .orderBy(sql`count(*) desc`)
    .limit(limit);
}

export async function recentEvents(limit = 100, onlyErrors = false) {
  const where = onlyErrors ? eq(usageEvents.status, 'error') : undefined;
  return getDb()
    .select()
    .from(usageEvents)
    .where(where)
    .orderBy(desc(usageEvents.ts))
    .limit(limit);
}

export async function recentAudit(limit = 100, action?: string) {
  const where = action ? eq(auditLog.action, action) : undefined;
  return getDb().select().from(auditLog).where(where).orderBy(desc(auditLog.ts)).limit(limit);
}

/**
 * Entfernt alte Nutzungsdaten. Der Audit-Trail bleibt bewusst laenger erhalten:
 * er dient dem Nachweis und nicht der Betriebsauswertung.
 */
export async function pruneUsage(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await getDb().delete(usageEvents).where(lt(usageEvents.ts, cutoff));
  return Number((result as unknown as { count?: number }).count ?? 0);
}
