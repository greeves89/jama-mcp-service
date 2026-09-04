import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAdminRoutes } from './admin/routes.js';
import { pruneAuthTables } from './admin/auth.js';
import { registerMcpRoute } from './mcp/http-route.js';
import { closeDb, pingDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { getSettings } from './service/settings.js';
import { pruneUsage } from './service/usage.js';
import { jamaCache } from './jama/cache.js';
import { getConfig } from './shared/config.js';
import { logger } from './shared/logger.js';
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

export async function createServer() {
  const config = getConfig();

  const app = Fastify({
    // Fastifys eigenes Request-Logging bleibt aus: es schreibt zwei Zeilen pro
    // Anfrage, auch fuer jede Datei des Dashboards, und ertraenkt damit genau
    // das, was man im Betrieb sucht. Stattdessen protokolliert der Hook weiter
    // unten gezielt jede Antwort ab Status 400 — und bei LOG_LEVEL=debug
    // zusaetzlich die erfolgreichen.
    logger: false,
    // Hinter nginx: die echte Client-Adresse steht in X-Forwarded-For und wird
    // fuer die Anmeldesperre gebraucht.
    trustProxy: true,
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
      version: process.env.npm_package_version ?? '1.0.0',
    });
  });

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
