import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './mcp/server.js';
import { JamaClient } from './jama/client.js';
import { jamaCredentialsSchema, type JamaCredentials } from './jama/auth.js';
import { TOOLSETS, parseToolsets, type Toolset } from './shared/toolsets.js';
import { allTools } from './mcp/registry.js';

/**
 * Einzelplatzbetrieb ohne Datenbank und ohne Admin-Oberflaeche.
 *
 * Gedacht fuer Entwickler, die den Server lokal an ihren MCP-Client haengen
 * wollen. Die Zugangsdaten kommen aus der Umgebung statt aus der verschluesselten
 * Ablage — entsprechend gibt es hier weder Nutzungsauswertung noch Audit-Trail.
 * Fuer den gemeinsamen Betrieb ist der HTTP-Modus vorgesehen.
 */

function credentialsAusUmgebung(): JamaCredentials {
  const clientId = process.env.JAMA_CLIENT_ID;
  const clientSecret = process.env.JAMA_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return jamaCredentialsSchema.parse({ type: 'oauth', clientId, clientSecret });
  }

  const username = process.env.JAMA_USERNAME;
  const password = process.env.JAMA_PASSWORD;
  if (username && password) {
    return jamaCredentialsSchema.parse({ type: 'basic', username, password });
  }

  throw new Error(
    'Es fehlen Zugangsdaten. Entweder JAMA_CLIENT_ID und JAMA_CLIENT_SECRET (OAuth, empfohlen) oder JAMA_USERNAME und JAMA_PASSWORD (Basic Auth) setzen.',
  );
}

function toolsetsAusUmgebung(): Toolset[] {
  const raw = process.env.JAMA_TOOLSETS;
  if (!raw || raw.trim() === '') return ['core', 'trace'];
  if (raw.trim() === 'all') return [...TOOLSETS];
  const parsed = parseToolsets(raw.split(',').map((entry) => entry.trim()));
  if (parsed.length === 0) {
    throw new Error(
      `JAMA_TOOLSETS enthaelt keinen gueltigen Wert. Erlaubt sind: ${TOOLSETS.join(', ')} oder "all".`,
    );
  }
  return parsed;
}

async function main(): Promise<void> {
  const baseUrl = process.env.JAMA_BASE_URL;
  if (!baseUrl) {
    throw new Error('JAMA_BASE_URL fehlt, z. B. https://beispiel.jamacloud.com');
  }

  // Im stdio-Betrieb gibt es keine Datenbank; die Konfiguration wird deshalb
  // nur so weit gelesen, wie sie hier tatsaechlich gebraucht wird.
  process.env.DATABASE_URL ??= 'postgres://unbenutzt';
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32).toString('base64');
  process.env.SESSION_SECRET ??= Buffer.alloc(32).toString('base64');

  const readOnly = process.env.JAMA_READ_ONLY !== 'false';
  const projekte = (process.env.JAMA_ALLOWED_PROJECTS ?? '')
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry));

  const client = new JamaClient({
    connectionId: 'stdio',
    baseUrl,
    credentials: credentialsAusUmgebung(),
    rateLimitRps: process.env.JAMA_RATE_LIMIT_RPS
      ? Number.parseFloat(process.env.JAMA_RATE_LIMIT_RPS)
      : undefined,
  });

  const server = buildMcpServer({
    client,
    apiKeyName: 'stdio',
    allowedProjectIds: projekte,
    readOnly,
    toolsets: toolsetsAusUmgebung(),
    tokenBudget: Number.parseInt(process.env.MCP_RESPONSE_TOKEN_BUDGET ?? '15000', 10),
    audit: () => {
      // Ohne Datenbank kein Audit-Trail. Das ist der Preis des Einzelplatzbetriebs
      // und der Grund, warum schreibende Zugriffe hier standardmaessig aus sind.
    },
  });

  // Auf stdout laeuft das Protokoll — jede andere Ausgabe wuerde es zerstoeren.
  process.stderr.write(
    `jama-mcp (stdio) bereit: ${allTools.length} Tools verfuegbar, Modus ${readOnly ? 'nur lesend' : 'schreibend'}\n`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`Start fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
