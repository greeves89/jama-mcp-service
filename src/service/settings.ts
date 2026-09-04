import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { settings } from '../db/schema.js';
import { getConfig } from '../shared/config.js';

/**
 * Laufzeiteinstellungen, die im Admin-Dashboard geaendert werden koennen, ohne
 * den Dienst neu zu starten. Die Umgebungsvariablen bilden nur die Startwerte —
 * was in der Datenbank steht, gewinnt.
 */

export interface RuntimeSettings {
  /** Notbremse: sperrt alle schreibenden Tools unabhaengig von den Key-Einstellungen. */
  globalReadOnly: boolean;
  /** Antwortbudget je Tool-Aufruf in Token. */
  responseTokenBudget: number;
  /** Aufbewahrung der Nutzungsdaten in Tagen. */
  usageRetentionDays: number;
  /**
   * Namen instanzweit abgeschalteter Tools. Sie werden gar nicht erst am
   * MCP-Server registriert und tauchen deshalb in keinem Client auf —
   * unabhaengig davon, welche Toolsets ein Zugang freigeschaltet hat.
   *
   * Gedacht fuer den Fall, dass ein einzelnes Tool unerwuenscht ist, sein
   * Toolset aber gebraucht wird — etwa "write" ohne jama_delete_item.
   */
  disabledTools: string[];
  /**
   * Vermerkt jede vom Dienst ausgeloeste Aenderung als Kommentar am Item.
   *
   * Jama protokolliert zwar selbst, aber nur den technischen Benutzer, unter
   * dem die Anbindung arbeitet. Wer die Aenderung im Chatfenster veranlasst
   * hat, steht dort nicht — bei einem gemeinsam genutzten Zugang laesst sich
   * die Herkunft im Nachhinein sonst nicht mehr klaeren. Der Kommentar traegt
   * diese Angabe nach.
   *
   * Kostet je geaenderten Item einen zusaetzlichen Jama-Aufruf, faellt also
   * beim Anlegen vieler Items ins Gewicht.
   */
  vermerkeHerkunft: boolean;
}

const CACHE_TTL_MS = 10_000;
let cache: { value: RuntimeSettings; expiresAt: number } | undefined;

function defaults(): RuntimeSettings {
  const config = getConfig();
  return {
    globalReadOnly: config.GLOBAL_READ_ONLY,
    responseTokenBudget: config.MCP_RESPONSE_TOKEN_BUDGET,
    usageRetentionDays: config.USAGE_RETENTION_DAYS,
    disabledTools: [],
    vermerkeHerkunft: false,
  };
}

/**
 * Kurz gecacht: die Einstellungen werden bei jedem Tool-Aufruf gebraucht, aber
 * eine Aenderung im Admin darf nicht erst nach einem Neustart wirken. Zehn
 * Sekunden sind der Kompromiss — bei der Notbremse zaehlt jede Sekunde, ein
 * Datenbankzugriff pro Tool-Aufruf waere aber unnoetig.
 */
export async function getSettings(): Promise<RuntimeSettings> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const base = defaults();
  try {
    const rows = await getDb().select().from(settings);
    for (const row of rows) {
      if (row.key === 'globalReadOnly' && typeof row.value === 'boolean') {
        base.globalReadOnly = row.value;
      }
      if (row.key === 'responseTokenBudget' && typeof row.value === 'number') {
        base.responseTokenBudget = row.value;
      }
      if (row.key === 'usageRetentionDays' && typeof row.value === 'number') {
        base.usageRetentionDays = row.value;
      }
      if (row.key === 'disabledTools' && Array.isArray(row.value)) {
        base.disabledTools = row.value.filter((entry): entry is string => typeof entry === 'string');
      }
    }
  } catch {
    // Ist die Datenbank kurzzeitig nicht erreichbar, gelten die Startwerte.
    // Insbesondere bleibt eine per Umgebung gesetzte Notbremse damit wirksam.
  }

  cache = { value: base, expiresAt: Date.now() + CACHE_TTL_MS };
  return base;
}

export async function setSetting(
  key: keyof RuntimeSettings,
  value: boolean | number | string[],
  updatedBy: string,
): Promise<void> {
  await getDb()
    .insert(settings)
    .values({ key, value, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedBy, updatedAt: new Date() },
    });
  cache = undefined;
}

export async function getSetting(key: string): Promise<unknown> {
  const rows = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
  return rows[0]?.value;
}

export function invalidateSettingsCache(): void {
  cache = undefined;
}
