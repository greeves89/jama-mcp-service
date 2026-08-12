import { CallStats, JamaHttp } from './http.js';
import { getRateLimiter } from './rate-limiter.js';
import { SchemaResolver } from './schema.js';
import type { JamaCredentials } from './auth.js';
import type { JamaCapabilities, JamaUser } from './types.js';
import { getConfig } from '../shared/config.js';

/**
 * Buendelt HTTP-Zugriff und Schema-Aufloesung zu einem Objekt, das die Tools
 * benutzen. Pro Tool-Aufruf wird eine Instanz erzeugt, damit die Statistik
 * (Jama-Aufrufe, Wiederholungen, Cache-Treffer) genau diesem Aufruf zugeordnet
 * werden kann. Der Rate-Limiter und der Cache sind dagegen instanzuebergreifend
 * und haengen an der Verbindung.
 */
export class JamaClient {
  readonly http: JamaHttp;
  readonly schema: SchemaResolver;
  readonly stats: CallStats;
  readonly connectionId: string;

  constructor(options: {
    connectionId: string;
    baseUrl: string;
    credentials: JamaCredentials;
    rateLimitRps?: number;
    maxRetries?: number;
    fetchImpl?: typeof fetch;
  }) {
    const config = getConfig();
    this.connectionId = options.connectionId;
    this.stats = new CallStats();
    this.http = new JamaHttp({
      baseUrl: options.baseUrl,
      credentials: options.credentials,
      rateLimiter: getRateLimiter(
        options.connectionId,
        options.rateLimitRps ?? config.JAMA_RATE_LIMIT_RPS,
      ),
      maxRetries: options.maxRetries ?? config.JAMA_MAX_RETRIES,
      stats: this.stats,
      fetchImpl: options.fetchImpl,
    });
    this.schema = new SchemaResolver(this.http, options.connectionId);
  }

  /** Aktueller Benutzer — dient zugleich als Verbindungstest. */
  async currentUser(): Promise<JamaUser> {
    const response = await this.http.request<JamaUser>('users/current');
    return response.data;
  }

  /**
   * Ermittelt die verfuegbaren API-Versionen. Daraus leitet sich ab, ob die
   * labs-Toolsets (Reviews, Reports) ueberhaupt angeboten werden duerfen.
   */
  async capabilities(): Promise<JamaCapabilities> {
    // GET /rest liegt ausserhalb der Versionspfade und wird deshalb direkt geholt.
    const response = await this.http.request<{ data?: unknown } | string[]>('', {
      apiVersion: 'v1',
    });

    const raw = JSON.stringify(response.data ?? response);
    const versions = ['v1', 'latest', 'labs'].filter((version) => raw.includes(version));

    return {
      versions: versions.length > 0 ? versions : ['v1'],
      hasLabs: versions.includes('labs'),
      detectedAt: new Date().toISOString(),
    };
  }
}

export interface ConnectionHealth {
  ok: boolean;
  message: string;
  user?: string;
  licenseType?: string;
  capabilities?: JamaCapabilities;
  latencyMs: number;
}

/**
 * Prueft eine Verbindung End-zu-Ende: Authentifizierung, Erreichbarkeit,
 * Lizenztyp und verfuegbare API-Versionen. Der Lizenztyp ist wichtig, weil
 * Jama den REST-Zugriff auf Named-Creator-Lizenzen beschraenkt — mit einer
 * Creator-Float-Lizenz scheitert spaeter jeder Aufruf, und die Ursache ist
 * ohne diesen Hinweis schwer zu finden.
 */
export async function checkConnection(client: JamaClient): Promise<ConnectionHealth> {
  const started = Date.now();
  try {
    const user = await client.currentUser();
    let capabilities: JamaCapabilities | undefined;
    try {
      capabilities = await client.capabilities();
    } catch {
      // Die Versionsabfrage ist nicht kritisch — die Verbindung steht ja bereits.
      capabilities = undefined;
    }

    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;
    const license = user.licenseType;
    const licenseWarning =
      license && !/named/i.test(license) && !/creator/i.test(license)
        ? ` Achtung: Lizenztyp "${license}" — der REST-Zugriff erfordert eine Named-Creator-Lizenz.`
        : '';

    return {
      ok: true,
      message: `Verbunden als ${name}.${licenseWarning}`,
      user: name,
      licenseType: license,
      capabilities,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    };
  }
}
