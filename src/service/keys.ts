import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { apiKeys, jamaConnections, type ApiKey, type JamaConnection } from '../db/schema.js';
import { AuthError, ServiceError } from '../shared/errors.js';
import {
  decryptSecret,
  encryptSecret,
  hashApiKey,
  parseApiKey,
  safeCompareHex,
} from '../shared/crypto.js';
import { getConfig } from '../shared/config.js';
import { ensureCore, parseToolsets, type Toolset } from '../shared/toolsets.js';
import { jamaCredentialsSchema, type JamaCredentials } from '../jama/auth.js';
import { JamaClient } from '../jama/client.js';
import { getSettings } from './settings.js';
import type { ToolContext } from '../mcp/types.js';

/**
 * Aufloesung eines praesentierten API-Keys zu einem einsatzbereiten Kontext.
 *
 * Hier laufen beide Auth-Ebenen zusammen: der Key identifiziert den Zugang bei
 * uns, und aus dem Zugang ergeben sich die Jama-Zugangsdaten, mit denen wir
 * gegenueber Jama auftreten. Die Jama-Berechtigungen bleiben dabei unangetastet —
 * dieser Dienst weitet sie nie aus, er schraenkt hoechstens weiter ein.
 */

export interface ResolvedKey {
  key: ApiKey;
  connection: JamaConnection;
  credentials: JamaCredentials;
  toolsets: Toolset[];
  readOnly: boolean;
}

export async function resolveApiKey(presented: string | undefined): Promise<ResolvedKey> {
  if (!presented || presented.trim() === '') {
    throw new AuthError(
      'AUTH_MISSING',
      'Es wurde kein API-Key uebergeben. Er gehoert in den Header "Authorization: Bearer <key>".',
    );
  }

  const parsed = parseApiKey(presented.trim());
  if (!parsed) {
    throw new AuthError('AUTH_INVALID', 'Der API-Key hat nicht das erwartete Format.');
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyPrefix, parsed.prefix))
    .limit(1);

  const key = rows[0];

  // Auch bei unbekanntem Praefix wird gehasht und verglichen, damit die
  // Antwortzeit nicht verraet, ob ein Key existiert.
  const presentedHash = hashApiKey(presented.trim());
  const stored = key?.keyHash ?? '0'.repeat(64);
  const matches = safeCompareHex(presentedHash, stored);

  if (!key || !matches) {
    throw new AuthError('AUTH_INVALID', 'Der API-Key ist unbekannt oder ungueltig.');
  }

  if (key.disabledAt) {
    throw new AuthError('AUTH_DISABLED', 'Dieser API-Key wurde deaktiviert.', 403);
  }
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
    throw new AuthError(
      'AUTH_EXPIRED',
      `Dieser API-Key ist am ${key.expiresAt.toISOString().slice(0, 10)} abgelaufen.`,
      403,
    );
  }

  const connectionRows = await db
    .select()
    .from(jamaConnections)
    .where(eq(jamaConnections.id, key.connectionId))
    .limit(1);

  const connection = connectionRows[0];
  if (!connection) {
    throw new ServiceError(
      'CONNECTION_MISSING',
      'Die dem Key zugeordnete Jama-Verbindung existiert nicht mehr.',
      500,
    );
  }

  const credentials = decryptCredentials(key, connection);

  const settings = await getSettings();
  // Auch bereits bestehende Zugaenge ohne "core" werden hier geheilt — sonst
  // bliebe eine einmal falsch angelegte Konfiguration dauerhaft unbrauchbar.
  const toolsets = ensureCore(parseToolsets(key.toolsets));

  return {
    key,
    connection,
    credentials,
    toolsets,
    // Die globale Notbremse kann nur verschaerfen, nie lockern.
    readOnly: key.readOnly || settings.globalReadOnly,
  };
}

/**
 * Bevorzugt die Zugangsdaten des Keys (Modell "pro Person"); nur wenn keine
 * hinterlegt sind, wird auf die der Verbindung zurueckgegriffen
 * (Modell "Service-Account").
 */
function decryptCredentials(key: ApiKey, connection: JamaConnection): JamaCredentials {
  const encrypted = key.jamaCredentialsEnc ?? connection.credentialsEnc;
  const encryptionKey = getConfig().ENCRYPTION_KEY;

  let raw: string;
  try {
    raw = decryptSecret(encrypted, encryptionKey);
  } catch (error) {
    throw new ServiceError(
      'CONNECTION_MISSING',
      `Die hinterlegten Jama-Zugangsdaten liessen sich nicht entschluesseln: ${
        error instanceof Error ? error.message : String(error)
      }`,
      500,
    );
  }

  const parsed = jamaCredentialsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new ServiceError(
      'CONNECTION_MISSING',
      'Die hinterlegten Jama-Zugangsdaten haben ein unerwartetes Format.',
      500,
    );
  }
  return parsed.data;
}

/** Gegenstueck zu decryptCredentials — fuer das Anlegen und Aendern im Admin. */
export function encryptCredentials(credentials: JamaCredentials): string {
  return encryptSecret(JSON.stringify(credentials), getConfig().ENCRYPTION_KEY);
}

/** Baut aus einem aufgeloesten Key den Kontext fuer die Tool-Aufrufe. */
export async function buildToolContext(resolved: ResolvedKey): Promise<ToolContext> {
  const settings = await getSettings();

  const client = new JamaClient({
    connectionId: resolved.connection.id,
    baseUrl: resolved.connection.baseUrl,
    credentials: resolved.credentials,
    rateLimitRps:
      resolved.key.rateLimitRps ?? resolved.connection.rateLimitRps ?? undefined,
  });

  return {
    client,
    apiKeyId: resolved.key.id,
    apiKeyName: resolved.key.name,
    allowedProjectIds: resolved.key.allowedProjectIds ?? [],
    readOnly: resolved.readOnly,
    toolsets: resolved.toolsets,
    disabledTools: settings.disabledTools,
    tokenBudget: settings.responseTokenBudget,
    vermerkeHerkunft: settings.vermerkeHerkunft,
    audit: () => {
      // Wird vom MCP-Server ueberschrieben; hier nur als sicherer Standard.
    },
  };
}

/** Notiert die Benutzung, damit ungenutzte Keys im Admin auffallen. */
export async function markKeyUsed(apiKeyId: string): Promise<void> {
  await getDb()
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, apiKeyId));
}

/**
 * Regeln fuer das Aendern eines bestehenden API-Keys.
 *
 * Bewusst hier und nicht in der Route: was beim Aendern passieren darf, ist
 * eine fachliche Frage und ohne Datenbank pruefbar.
 */
export interface KeyAenderung {
  name?: string;
  owner?: string;
  toolsets?: Toolset[];
  allowedProjectIds?: number[];
  readOnly?: boolean;
  rateLimitRps?: number | null;
  /** null entfernt ein gesetztes Ablaufdatum wieder. */
  expiresAt?: string | null;
  note?: string | null;
  /** null entfernt eigene Zugangsdaten; der Key nutzt dann die der Verbindung. */
  credentials?: JamaCredentials | null;
  disabled?: boolean;
}

/**
 * Baut die zu schreibenden Spalten fuer einen API-Key.
 *
 * Weggelassene Felder bleiben unangetastet — nur so laesst sich etwa ein
 * fehlendes Toolset ergaenzen, ohne die hinterlegten Jama-Zugangsdaten erneut
 * einzugeben, die ohnehin niemand mehr zur Hand hat.
 *
 * Das Verschluesseln wird hereingereicht, damit die Funktion ohne
 * Schluesselmaterial auskommt und im Test nachvollziehbar bleibt.
 */
export function baueKeyUpdate(
  aenderung: KeyAenderung,
  verschluesseln: (credentials: JamaCredentials) => string,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};

  if (aenderung.name !== undefined) update.name = aenderung.name;
  if (aenderung.owner !== undefined) update.owner = aenderung.owner;
  // Ohne "core" fehlt der Weg vom Projektnamen zur ID; alle uebrigen Toolsets
  // laufen dann ins Leere. Deshalb auch beim Aendern erzwungen.
  if (aenderung.toolsets !== undefined) update.toolsets = ensureCore(aenderung.toolsets);
  if (aenderung.allowedProjectIds !== undefined) {
    update.allowedProjectIds = aenderung.allowedProjectIds;
  }
  if (aenderung.readOnly !== undefined) update.readOnly = aenderung.readOnly;
  if (aenderung.rateLimitRps !== undefined) update.rateLimitRps = aenderung.rateLimitRps;
  if (aenderung.note !== undefined) update.note = aenderung.note;

  if (aenderung.expiresAt !== undefined) {
    // null heisst ausdruecklich "laeuft nicht mehr ab". Ohne diesen Zweig liesse
    // sich ein einmal gesetztes Ablaufdatum nie wieder entfernen.
    if (aenderung.expiresAt === null) {
      update.expiresAt = null;
    } else {
      const datum = new Date(aenderung.expiresAt);
      if (Number.isNaN(datum.getTime())) {
        throw new ServiceError(
          'VALIDATION',
          `"${aenderung.expiresAt}" ist kein gültiges Datum.`,
          400,
        );
      }
      update.expiresAt = datum;
    }
  }

  if (aenderung.credentials !== undefined) {
    // null heisst: eigene Zugangsdaten entfernen und wieder die der Verbindung
    // verwenden. Ohne diesen Zweig liesse sich ein Key, dem einmal eigene
    // Daten mitgegeben wurden, nie wieder auf den Service-Account umstellen.
    update.jamaCredentialsEnc =
      aenderung.credentials === null ? null : verschluesseln(aenderung.credentials);
  }

  if (aenderung.disabled !== undefined) {
    update.disabledAt = aenderung.disabled ? new Date() : null;
  }

  return update;
}
