import Fastify, { type FastifyInstance } from 'fastify';
import type { FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAdminRoutes } from './admin/routes.js';
import { pruneAuthTables } from './admin/auth.js';
import { registerMcpRoute } from './mcp/http-route.js';
import { entraEingerichtet } from './auth/entra.js';
import { closeDb, pingDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { getSettings } from './service/settings.js';
import { pruneUsage } from './service/usage.js';
import { jamaCache } from './jama/cache.js';
import { getConfig } from './shared/config.js';
import { logger } from './shared/logger.js';
import { VERSION } from './shared/version.js';
import { allTools } from './mcp/registry.js';

/**
 * Einstiegspunkt fuer den Serverbetrieb.
 *
 * MCP-Endpunkt und Admin-Oberflaeche laufen bewusst im selben Prozess: sie
 * teilen sich den Rate-Limiter und den Stammdaten-Cache. Waeren es zwei
 * Prozesse, muessten beide Zustaende ueber einen externen Speicher
 * synchronisiert werden — zusaetzliche bewegliche Teile, die der Betrieb auf
 * einem einzelnen Rechner nicht rechtfertigt.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Entdeckungsdokument der geschuetzten Ressource (RFC 9728).
 *
 * Ohne Anmeldung erreichbar, und das muss so sein: Erst hier erfaehrt ein
 * Client, bei wem er ein Token holen soll und fuer welche Ressource. Der 401
 * am MCP-Pfad verweist mit "WWW-Authenticate: Bearer resource_metadata=..."
 * hierher; beides zusammen ist die Kette, ueber die sich ein Client selbst
 * anmelden kann.
 *
 * Ist der Firmenzugang nicht eingerichtet, antwortet der Pfad mit 404. Ein
 * Dokument, das auf einen leeren Aussteller verweist, schickt Clients in eine
 * Anmeldung, die es nicht gibt — sie scheiterten dann an einer Stelle, an der
 * niemand die Ursache vermutet.
 *
 * Getrennt exportiert, damit die Form ohne Datenbank und ohne Admin-Oberflaeche
 * pruefbar bleibt (tests/entdeckung.test.ts).
 */
export function registriereEntdeckung(app: FastifyInstance): void {
  const ausliefern = async (_request: unknown, reply: FastifyReply) => {
    if (!entraEingerichtet()) {
      return reply.status(404).send({ fehler: 'Nicht gefunden' });
    }

    const config = getConfig();
    return reply.send({
      resource: config.ENTRA_AUDIENCE,
      authorization_servers: [config.ENTRA_ISSUER],
      scopes_supported: [config.ENTRA_SCOPE],
      bearer_methods_supported: ['header'],
    });
  };

  app.get('/.well-known/oauth-protected-resource', ausliefern);

  // Dieselbe Auskunft noch einmal unter dem pfadbehafteten Namen.
  //
  // RFC 9728 kennt beide Formen: den Wurzelpfad und einen, der den Pfad der
  // geschuetzten Ressource anhaengt. Welche ein Client zuerst probiert, ist
  // nicht festgelegt — und ein Client, der die falsche waehlt, bekommt einen
  // 404 und bricht die Anmeldung ab, ohne dass jemand den Grund sieht. Eine
  // zweite Zeile ist billiger als dieser Ausfall.
  app.get('/.well-known/oauth-protected-resource/mcp', ausliefern);
}

export async function createServer() {
  const config = getConfig();

  const app = Fastify({
    // Fastifys eigenes Request-Logging bleibt aus: es schreibt zwei Zeilen pro
    // Anfrage, auch fuer jede Datei des Dashboards, und ertraenkt damit genau
    // das, was man im Betrieb sucht. Stattdessen protokolliert der Hook weiter
    // unten gezielt jede Antwort ab Status 400 — und bei LOG_LEVEL=debug
    // zusaetzlich die erfolgreichen.
    logger: false,
    // Hinter nginx oder Traefik: die echte Client-Adresse steht in
    // X-Forwarded-For und wird fuer die Anmeldesperre gebraucht.
    //
    // Nicht "true": Dann vertraut Fastify dem vollstaendigen Header und nimmt
    // dessen linkesten Eintrag — den ein Angreifer selbst mitschicken kann. Er
    // koennte sich fuer jeden Rateversuch eine neue Adresse ausdenken und die
    // Anmeldesperre damit aushebeln.
    //
    // Und ausdruecklich eine FUNKTION, nicht die blosse Zahl: Fastify wertet
    // eine Zahl nicht als Hop-Zaehler aus, sondern verwirft sie und traut dann
    // gar keinem Eintrag mehr (lib/request.js). Die Folge waere kein
    // Sicherheitsloch, aber ein stiller Ausfall — request.ip lieferte immer die
    // Docker-Adresse des Proxys, alle Anwender landeten in einem gemeinsamen
    // Sperr-Topf, und ein einziger Fehlversuch sperrte alle Admins aus.
    // tests/trust-proxy.test.ts haelt das fest, damit ein spaeteres
    // "Vereinfachen" zur Zahl auffaellt.
    //
    // Fastify geht die Adressen von rechts durch und fragt fuer jede, ob ihr zu
    // trauen ist. Die ersten TRUST_PROXY_HOPS stammen von den eigenen Proxys.
    trustProxy: (_adresse: string, sprung: number) => sprung < config.TRUST_PROXY_HOPS,
    bodyLimit: 20 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });

  /**
   * Jede fehlerhafte Antwort wird sichtbar.
   *
   * Vorher blieb der Betrieb blind: Ein fehlgeschlagener Verbindungstest, eine
   * abgewiesene Anmeldung oder ein 500er tauchten in "docker logs" nirgends
   * auf, weil die Admin-API ihre Fehler ausschliesslich an den Browser
   * schickte. Wer nur das Containerlog hatte, sah einen stillen Dienst und
   * keinen Hinweis auf die Ursache.
   *
   * Ab Status 500 wird als Fehler protokolliert, 4xx als Warnung: das eine ist
   * unser Problem, das andere in aller Regel eine Fehlbedienung oder ein
   * abgelehnter Zugriff.
   */
  app.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode;
    const daten = {
      methode: request.method,
      pfad: request.url,
      status,
      dauerMs: Math.round(reply.elapsedTime),
      ip: request.ip,
    };

    if (status >= 500) {
      logger.error(daten, 'Anfrage fehlgeschlagen');
    } else if (status >= 400) {
      logger.warn(daten, 'Anfrage abgewiesen');
    } else {
      logger.debug(daten, 'Anfrage beantwortet');
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (config.PUBLIC_BASE_URL.startsWith('https://')) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  app.get('/health', async (_request, reply) => {
    const datenbank = await pingDb();
    const settings = await getSettings().catch(() => undefined);
    return reply.status(datenbank ? 200 : 503).send({
      status: datenbank ? 'ok' : 'degraded',
      datenbank,
      tools: allTools.length,
      nurLesend: settings?.globalReadOnly ?? null,
      version: VERSION,
    });
  });

  registriereEntdeckung(app);
  registerMcpRoute(app);
  await registerAdminRoutes(app);

  // Gebautes Admin-Frontend ausliefern, sofern vorhanden. Im Entwicklungsbetrieb
  // laeuft stattdessen der Vite-Server.
  const webRoot = join(here, '..', 'web', 'dist');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/admin/', index: ['index.html'] });

    // Alle Unterpfade des Dashboards auf die Einstiegsseite leiten, damit ein
    // direkter Aufruf oder ein Neuladen nicht ins Leere laeuft.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/admin') && !request.url.startsWith('/admin/api')) {
        return reply.sendFile('index.html', webRoot);
      }
      return reply.status(404).send({ fehler: 'Nicht gefunden' });
    });
  } else {
    logger.warn(
      { webRoot },
      'Kein gebautes Admin-Frontend gefunden. Mit "npm run build:web" erzeugen oder im Entwicklungsbetrieb "npm run dev:web" nutzen.',
    );
  }

  app.get('/', async (_request, reply) => reply.redirect('/admin/'));

  return app;
}

/**
 * Wiederkehrende Aufraeumarbeiten. Bewusst im selben Prozess statt als Cron:
 * ein zusaetzlicher Dienst waere fuer drei Loeschabfragen nicht angemessen.
 */
function starteWartung(): NodeJS.Timeout {
  const stunde = 60 * 60 * 1000;
  return setInterval(() => {
    void (async () => {
      try {
        const settings = await getSettings();
        const entfernt = await pruneUsage(settings.usageRetentionDays);
        await pruneAuthTables();
        const geleert = jamaCache.prune();
        if (entfernt > 0 || geleert > 0) {
          logger.info(
            { nutzungsereignisse: entfernt, cacheEintraege: geleert },
            'Wartung abgeschlossen',
          );
        }
      } catch (error) {
        logger.error({ err: error }, 'Wartung fehlgeschlagen');
      }
    })();
  }, stunde).unref();
}

async function main(): Promise<void> {
  const config = getConfig();

  logger.info('Migrationen werden ausgefuehrt');
  await runMigrations();

  const app = await createServer();
  const wartung = starteWartung();

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info(
    { port: config.PORT, tools: allTools.length, umgebung: config.NODE_ENV },
    'Dienst gestartet',
  );

  const herunterfahren = async (signal: string) => {
    logger.info({ signal }, 'Dienst wird beendet');
    clearInterval(wartung);
    await app.close();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void herunterfahren('SIGTERM'));
  process.on('SIGINT', () => void herunterfahren('SIGINT'));
}

const istEinstiegspunkt =
  process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');

if (istEinstiegspunkt) {
  main().catch((error) => {
    logger.fatal({ err: error }, 'Start fehlgeschlagen');
    process.exit(1);
  });
}
