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
import { parseToolsets, type Toolset } from '../shared/toolsets.js';
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
  const toolsets = parseToolsets(key.toolsets);

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
