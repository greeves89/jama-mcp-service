import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb, pingDb } from '../db/client.js';
import { apiKeys, jamaConnections, usageEvents } from '../db/schema.js';
import {
  activeSessions,
  checkLockout,
  ensureInitialPin,
  isPinConfigured,
  login,
  logout,
  logoutAll,
  setPin,
  validateSession,
} from './auth.js';
import { encryptCredentials } from '../service/keys.js';
import { baueVerbindungsUpdate } from '../service/connections.js';
import { gleicheAb, letzterAbgleich, type Abgleichsergebnis } from '../service/abgleich.js';
import {
  ladePersonen,
  ladeProjekte,
  ladeZuordnung,
  setzeGrundstufe,
  setzeGrundstufeFuerAlle,
  setzeZuordnungMehrfach,
} from '../service/personen.js';
import {
  getSettings,
  invalidateSettingsCache,
  setSetting,
  type RuntimeSettings,
} from '../service/settings.js';
import {
  recentAudit,
  recentEvents,
  recordAudit,
  recordUsage,
  topKeys,
  topTools,
  usageSummary,
  usageTimeline,
} from '../service/usage.js';
import { generateApiKey } from '../shared/crypto.js';
import { getConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { ServiceError, toServiceError } from '../shared/errors.js';
import type { AuditIntent } from '../mcp/types.js';
import { DEFAULT_TOOLSETS, TOOLSET_INFO, TOOLSETS, ensureCore, parseToolsets } from '../shared/toolsets.js';
import { promptCatalog } from '../mcp/prompts.js';
import { toolCatalog, toolCountByToolset, getTool } from '../mcp/registry.js';
import { jamaCache } from '../jama/cache.js';
import { rateLimiterSnapshots } from '../jama/rate-limiter.js';
import { checkConnection, JamaClient } from '../jama/client.js';
import { jamaCredentialsSchema } from '../jama/auth.js';
import { baueKeyUpdate, buildToolContext, resolveApiKey } from '../service/keys.js';
import { redactArgs, runGuards } from '../mcp/guards.js';
import { renderResult } from '../mcp/server.js';

/**
 * Admin-API.
 *
 * Alle Routen ausser der Anmeldung erfordern eine gueltige Sitzung. Mutierende
 * Routen erfordern zusaetzlich einen CSRF-Token: das Session-Cookie ist zwar
 * sameSite=strict, aber der zweite Nachweis kostet nichts und schuetzt auch
 * dann, wenn der Dienst spaeter hinter einem Proxy mit anderer Cookie-Politik
 * landet.
 */

const SESSION_COOKIE = 'jama_admin_session';
const CSRF_COOKIE = 'jama_admin_csrf';
const CSRF_HEADER = 'x-csrf-token';

/**
 * Zeitgrenze fuer einen Abgleich.
 *
 * Ein Durchlauf ueber mehrere hundert Benutzer und Projekte sind etliche
 * Jama-Aufrufe, und Jama drosselt bei zehn Anfragen pro Sekunde fuer die
 * gesamte Instanz. Ueblicherweise ist er in unter einer Minute durch; zehn
 * Minuten decken auch eine traege Instanz ab und verhindern trotzdem, dass
 * eine Anfrage unbegrenzt offen haengt. Laeuft der Abgleich danach noch, wird
 * er nicht abgebrochen — er laeuft im Hintergrund weiter, nur die Antwort geht
 * ohne Ergebnis heraus.
 */
const ABGLEICH_ZEITGRENZE_MS = 10 * 60 * 1000;

/**
 * Obergrenze fuer eine Zuordnung in einem Zug.
 *
 * Die Zahl liegt weit ueber jeder realen Projektlandschaft. Ohne sie koennte
 * ein einziger Aufruf beliebig viel Speicher binden, weil der Rumpf vor der
 * Pruefung vollstaendig gelesen wird.
 */
const MAX_ZUORDNUNGSEINTRAEGE = 5000;

/**
 * Laeuft gerade ein Abgleich?
 *
 * Zwei gleichzeitige Laeufe schrieben denselben Spiegel und verdoppelten die
 * Last auf Jama. Der Zustand liegt im Prozess, wie auch der Zwischenspeicher
 * und die Ratenbegrenzung — der Dienst ist auf genau einen Prozess ausgelegt.
 */
let laufenderAbgleich: { seit: number; verbindung: { id: string; name: string } } | null = null;

function clientIp(request: FastifyRequest): string {
  return request.ip ?? 'unbekannt';
}

function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict' as const,
    path: '/',
  };
}

async function requireSession(request: FastifyRequest): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  await validateSession(token);
}

/**
 * Double-Submit-Verfahren: der Token steht in einem fuer JavaScript lesbaren
 * Cookie und muss zusaetzlich im Header mitgeschickt werden. Ein fremder Ursprung
 * kann das Cookie zwar mitsenden lassen, aber nicht auslesen.
 */
function requireCsrf(request: FastifyRequest): void {
  const cookie = request.cookies[CSRF_COOKIE];
  const header = request.headers[CSRF_HEADER];
  if (!cookie || typeof header !== 'string' || header !== cookie) {
    throw new ServiceError('AUTH_INVALID', 'CSRF-Token fehlt oder stimmt nicht ueberein.', 403);
  }
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  const serviceError = toServiceError(error);

  // Der Grund gehoert ins Log, nicht nur in die Antwort an den Browser. Ohne
  // das sah man im Containerlog bestenfalls einen Statuscode und musste raten,
  // woran es lag. Ab 500 als Fehler samt Stacktrace, darunter als Warnung.
  const daten = { code: serviceError.code, status: serviceError.httpStatus };
  if (serviceError.httpStatus >= 500) {
    logger.error({ ...daten, err: error }, serviceError.message);
  } else {
    logger.warn(daten, serviceError.message);
  }

  return reply
    .status(serviceError.httpStatus)
    .send({ fehler: serviceError.message, code: serviceError.code, details: serviceError.details });
}

/**
 * Urheber einer Aenderung.
 *
 * Wird an die veraendernden Dienste durchgereicht und landet von dort als
 * Akteur im Audit-Log. Das Dashboard kennt keinen Benutzernamen — es wird mit
 * einem einzigen PIN geoeffnet —, also ist die Adresse das einzige
 * unterscheidende Merkmal. Sie macht wenigstens nachvollziehbar, von wo aus
 * eine Zuordnung gesetzt wurde.
 */
function urheber(request: FastifyRequest): string {
  return `admin@${clientIp(request)}`;
}

/**
 * Verdeckt unerwartete Fehler aus Datenbank und Jama.
 *
 * Deren Meldungen nennen Tabellen, Spalten, Adressen und Antwortauszuege —
 * nichts davon gehoert in den Browser. Eigene Fehler unterhalb 500 sind
 * dagegen bewusst fuer den Aufrufer formuliert und bleiben unveraendert; nur
 * alles Uebrige wird zu einer allgemeinen Antwort, waehrend der Grund ins
 * Serverprotokoll geht.
 */
function verdeckeInterna(fehler: unknown, ersatz: string): ServiceError {
  if (fehler instanceof ServiceError && fehler.httpStatus < 500) return fehler;
  logger.error({ err: fehler }, ersatz);
  return new ServiceError('INTERNAL', ersatz, 500);
}

/** Fuehrt einen Dienstaufruf aus und verdeckt unerwartete Fehler. */
async function dienst<T>(aufruf: Promise<T>, ersatz: string): Promise<T> {
  try {
    return await aufruf;
  } catch (fehler) {
    throw verdeckeInterna(fehler, ersatz);
  }
}

/**
 * Wahrheitswert aus einem Abfrageparameter.
 *
 * `z.coerce.boolean()` macht aus der Zeichenkette "false" ein `true` — in der
 * Abfragezeile steht aber immer eine Zeichenkette. Deshalb die erlaubten Werte
 * ausdruecklich.
 */
const abfrageWahrheit = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((wert) => wert === true || wert === 'true' || wert === '1');

/**
 * Ein Abgleichsergebnis ohne Zahlen.
 *
 * Der Vertrag sagt zu, dass die Route ein `Abgleichsergebnis` liefert, und die
 * Oberflaeche liest `benutzer` und `projekte` ohne Pruefung. Auch die beiden
 * Faelle ohne beendeten Lauf — ein Abgleich laeuft bereits, oder er laeuft
 * ueber die Zeitgrenze hinaus weiter — muessen deshalb diese Form haben. Der
 * Grund steht in `warnungen`, wo die Oberflaeche ihn ohnehin anzeigt.
 */
function ergebnisOhneLauf(dauerMs: number, hinweis: string): Abgleichsergebnis {
  return {
    benutzer: { neu: 0, geaendert: 0, verschwunden: 0 },
    projekte: { neu: 0, geaendert: 0, verschwunden: 0 },
    dauerMs,
    warnungen: [hinweis],
  };
}

/**
 * Suchbegriff aus der Abfragezeile.
 *
 * Ein leeres Feld in der Oberflaeche schickt `?q=` mit. Ohne diese Umwandlung
 * waere das ein Pflichtverstoss und die Liste bliebe leer, statt einfach alles
 * zu zeigen. Die Laengengrenze haelt die Suchmuster klein.
 */
const suchbegriff = z
  .string()
  .max(200)
  .trim()
  .optional()
  .transform((wert) => (wert === undefined || wert === '' ? undefined : wert));

const stufeSchema = z.enum(['keine', 'lesen', 'schreiben']);

// Jama vergibt keine Null und keine negativen Benutzernummern.
const jamaUserIdParam = z.object({ jamaUserId: z.coerce.number().int().positive() });

const zeitraumSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  apiKeyId: z.string().uuid().optional(),
  toolName: z.string().optional(),
});

function zeitraum(query: unknown) {
  const parsed = zeitraumSchema.safeParse(query ?? {});
  const value = parsed.success ? parsed.data : {};
  return {
    from: value.from ? new Date(value.from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    to: value.to ? new Date(value.to) : undefined,
    apiKeyId: value.apiKeyId,
    toolName: value.toolName,
  };
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await ensureInitialPin();

  const secureCookies = getConfig().PUBLIC_BASE_URL.startsWith('https://');

  // --- Anmeldung ------------------------------------------------------------

  app.get('/admin/api/status', async (request, reply) => {
    const eingerichtet = await isPinConfigured();
    let angemeldet = false;
    try {
      await requireSession(request);
      angemeldet = true;
    } catch {
      angemeldet = false;
    }
    const sperre = await checkLockout(clientIp(request));
    return reply.send({ pinEingerichtet: eingerichtet, angemeldet, sperre });
  });

  app.post('/admin/api/login', async (request, reply) => {
    try {
      const body = z.object({ pin: z.string().min(1) }).parse(request.body);
      const result = await login(body.pin, clientIp(request), request.headers['user-agent']);

      const csrf = randomBytes(24).toString('base64url');

      reply.setCookie(SESSION_COOKIE, result.token, {
        ...cookieOptions(secureCookies),
        expires: result.expiresAt,
      });
      // Bewusst ohne httpOnly: das Frontend muss den Wert lesen koennen.
      reply.setCookie(CSRF_COOKIE, csrf, {
        httpOnly: false,
        secure: secureCookies,
        sameSite: 'strict',
        path: '/',
        expires: result.expiresAt,
      });

      await recordAudit(
        { action: 'admin.login', result: 'ok' },
        { type: 'admin', ip: clientIp(request) },
      );

      return reply.send({ angemeldet: true, gueltigBis: result.expiresAt });
    } catch (error) {
      await recordAudit(
        {
          action: 'admin.login.failed',
          result: 'denied',
          message: error instanceof Error ? error.message : String(error),
        },
        { type: 'admin', ip: clientIp(request) },
      );
      return sendError(reply, error);
    }
  });

  app.post('/admin/api/logout', async (request, reply) => {
    // Auch das Abmelden verlangt den CSRF-Nachweis. Der Schaden waere gering —
    // ein erzwungenes Abmelden, kein Datenzugriff —, aber die Pruefung kostet
    // nichts und haelt das Muster ueber alle veraendernden Routen einheitlich.
    try {
      requireCsrf(request);
    } catch (error) {
      return sendError(reply, error);
    }

    await logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.send({ abgemeldet: true });
  });

  // --- Ab hier: Sitzung erforderlich ---------------------------------------

  const geschuetzt = async (
    request: FastifyRequest,
    reply: FastifyReply,
    handler: () => Promise<unknown>,
    mutating = false,
  ) => {
    try {
      await requireSession(request);
      if (mutating) requireCsrf(request);
      return reply.send(await handler());
    } catch (error) {
      return sendError(reply, error);
    }
  };

  // --- Uebersicht -----------------------------------------------------------

  app.get('/admin/api/overview', async (request, reply) =>
    geschuetzt(request, reply, async () => {
      const jetzt = Date.now();
      const [heute, woche, monat] = await Promise.all([
        usageSummary({ from: new Date(jetzt - 24 * 60 * 60 * 1000) }),
        usageSummary({ from: new Date(jetzt - 7 * 24 * 60 * 60 * 1000) }),
        usageSummary({ from: new Date(jetzt - 30 * 24 * 60 * 60 * 1000) }),
      ]);

      const verbindungen = await getDb().select().from(jamaConnections);
      const schluessel = await getDb().select().from(apiKeys);
      const settings = await getSettings();

      const aktiveKeys = schluessel.filter(
        (key) =>
          !key.disabledAt && (!key.expiresAt || key.expiresAt.getTime() > jetzt),
      );
      // Ungenutzte Keys sind ein Sicherheitsrisiko: sie fallen niemandem auf,
      // bleiben aber gueltig.
      const ungenutzt = aktiveKeys.filter(
        (key) => !key.lastUsedAt || key.lastUsedAt.getTime() < jetzt - 60 * 24 * 60 * 60 * 1000,
      );

      return {
        gesundheit: {
          datenbank: await pingDb(),
          verbindungen: verbindungen.map((connection) => ({
            id: connection.id,
            name: connection.name,
            status: connection.healthStatus,
            meldung: connection.healthMessage,
            geprueft: connection.lastHealthCheckAt,
            produktiv: connection.isProduction,
          })),
        },
        nutzung: { heute, woche, monat },
        ratenbegrenzung: rateLimiterSnapshots(),
        cache: jamaCache.stats(),
        schluessel: {
          gesamt: schluessel.length,
          aktiv: aktiveKeys.length,
          ungenutzt: ungenutzt.map((key) => ({
            id: key.id,
            name: key.name,
            zuletzt: key.lastUsedAt,
          })),
        },
        topTools: await topTools({ from: new Date(jetzt - 7 * 24 * 60 * 60 * 1000) }, 5),
        letzteFehler: await recentEvents(10, true),
        einstellungen: settings,
        toolsProToolset: toolCountByToolset(),
      };
    }),
  );

  // --- Verbindungen ---------------------------------------------------------

  const verbindungSchema = z.object({
    name: z.string().min(1),
    baseUrl: z.string().url(),
    isProduction: z.boolean().default(false),
    rateLimitRps: z.number().min(0.5).max(10).optional(),
    credentials: jamaCredentialsSchema,
  });

  app.get('/admin/api/connections', async (request, reply) =>
    geschuetzt(request, reply, async () => {
      const rows = await getDb().select().from(jamaConnections).orderBy(jamaConnections.name);
      // Die verschluesselten Zugangsdaten verlassen den Server nie.
      return rows.map(({ credentialsEnc: _unused, ...rest }) => rest);
    }),
  );

  app.post('/admin/api/connections', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const body = verbindungSchema.parse(request.body);
        const [created] = await getDb()
          .insert(jamaConnections)
          .values({
            name: body.name,
            baseUrl: body.baseUrl.replace(/\/+$/, ''),
            authType: body.credentials.type,
            credentialsEnc: encryptCredentials(body.credentials),
            isProduction: body.isProduction,
            rateLimitRps: body.rateLimitRps ?? null,
          })
          .returning();

        await recordAudit(
          {
            action: 'connection.create',
            targetType: 'connection',
            targetKey: created?.id,
            payload: { name: body.name, produktiv: body.isProduction },
            result: 'ok',
          },
          { type: 'admin', ip: clientIp(request) },
        );

        const { credentialsEnc: _unused, ...rest } = created!;
        return rest;
      },
      true,
    ),
  );

  app.patch('/admin/api/connections/:id', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = verbindungSchema.partial().parse(request.body);

        const update = baueVerbindungsUpdate(body, encryptCredentials);

        const [updated] = await getDb()
          .update(jamaConnections)
          .set(update)
          .where(eq(jamaConnections.id, id))
          .returning();

        // Ohne diese Pruefung liefe eine unbekannte ID in einen Zugriff auf
        // undefined und damit in einen 500er, der nach einem Serverfehler
        // aussieht statt nach einem Tippfehler in der Adresse.
        if (!updated) {
          throw new ServiceError('CONNECTION_MISSING', 'Diese Jama-Verbindung existiert nicht.', 404);
        }

        await recordAudit(
          {
            action: 'connection.update',
            targetType: 'connection',
            targetKey: id,
            payload: { felder: Object.keys(update) },
            result: 'ok',
          },
          { type: 'admin', ip: clientIp(request) },
        );

        const { credentialsEnc: _unused, ...rest } = updated;
        return rest;
      },
      true,
    ),
  );

  app.delete('/admin/api/connections/:id', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

        const belegung = await getDb()
          .select({ anzahl: sql<number>`count(*)::int` })
          .from(apiKeys)
          .where(eq(apiKeys.connectionId, id));
        const anzahl = belegung[0]?.anzahl ?? 0;

        if (anzahl > 0) {
          throw new ServiceError(
            'VALIDATION',
            `Die Verbindung wird noch von ${anzahl} API-Keys genutzt. Diese zuerst löschen oder umhängen.`,
            409,
          );
        }

        await getDb().delete(jamaConnections).where(eq(jamaConnections.id, id));
        await recordAudit(
          { action: 'connection.delete', targetType: 'connection', targetKey: id, result: 'ok' },
          { type: 'admin', ip: clientIp(request) },
        );
        return { geloescht: true };
      },
      true,
    ),
  );

  app.post('/admin/api/connections/:id/test', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const rows = await getDb()
          .select()
          .from(jamaConnections)
          .where(eq(jamaConnections.id, id))
          .limit(1);
        const connection = rows[0];
        if (!connection) throw new ServiceError('VALIDATION', 'Verbindung nicht gefunden.', 404);

        const { decryptSecret } = await import('../shared/crypto.js');
        const credentials = jamaCredentialsSchema.parse(
          JSON.parse(decryptSecret(connection.credentialsEnc, getConfig().ENCRYPTION_KEY)),
        );

        const client = new JamaClient({
          connectionId: connection.id,
          baseUrl: connection.baseUrl,
          credentials,
          rateLimitRps: connection.rateLimitRps ?? undefined,
        });

        const health = await checkConnection(client);

        // Die Route liefert 200, auch wenn Jama die Anmeldung ablehnt: der
        // Test ist dann fachlich negativ, aber technisch erfolgreich
        // durchgelaufen. Ohne diesen Eintrag bliebe ein fehlgeschlagener Test
        // im Containerlog vollstaendig unsichtbar.
        if (health.ok) {
          logger.info(
            { verbindung: connection.name, instanz: connection.baseUrl },
            'Verbindungstest erfolgreich',
          );
        } else {
          logger.warn(
            {
              verbindung: connection.name,
              instanz: connection.baseUrl,
              grund: health.message,
            },
            'Verbindungstest fehlgeschlagen',
          );
        }

        await getDb()
          .update(jamaConnections)
          .set({
            healthStatus: health.ok ? 'ok' : 'error',
            healthMessage: health.message,
            lastHealthCheckAt: new Date(),
            apiVersion: health.capabilities?.versions.join(', ') ?? connection.apiVersion,
            capabilities: health.capabilities
              ? (health.capabilities as unknown as Record<string, unknown>)
              : connection.capabilities,
          })
          .where(eq(jamaConnections.id, id));

        return health;
      },
      true,
    ),
  );

  // --- API-Keys -------------------------------------------------------------

  const keySchema = z.object({
    name: z.string().min(1),
    owner: z.string().min(1),
    accountType: z.enum(['user', 'service']).default('user'),
    connectionId: z.string().uuid(),
    // null entfernt eigene Zugangsdaten wieder.
    credentials: jamaCredentialsSchema.nullable().optional(),
    toolsets: z.array(z.enum(TOOLSETS)).default(DEFAULT_TOOLSETS),
    allowedProjectIds: z.array(z.number().int()).default([]),
    readOnly: z.boolean().default(true),
    rateLimitRps: z.number().min(0.5).max(10).optional(),
    // null entfernt ein gesetztes Ablaufdatum wieder.
    expiresAt: z.string().nullable().optional(),
    note: z.string().optional(),
  });

  app.get('/admin/api/keys', async (request, reply) =>
    geschuetzt(request, reply, async () => {
      const rows = await getDb().select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
      const seit = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const nutzung = await getDb()
        .select({
          apiKeyId: usageEvents.apiKeyId,
          aufrufe: sql<number>`count(*)::int`,
          fehler: sql<number>`count(*) filter (where ${usageEvents.status} = 'error')::int`,
        })
        .from(usageEvents)
        .where(gte(usageEvents.ts, seit))
        .groupBy(usageEvents.apiKeyId);

      const nachId = new Map(nutzung.map((row) => [row.apiKeyId, row]));

      return rows.map(({ keyHash: _hash, jamaCredentialsEnc: _creds, ...rest }) => ({
        ...rest,
        eigeneCredentials: _creds !== null,
        nutzung30Tage: nachId.get(rest.id) ?? { aufrufe: 0, fehler: 0 },
      }));
    }),
  );

  app.post('/admin/api/keys', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const body = keySchema.parse(request.body);

        // Service-Accounts sind maschinelle Zugaenge, die niemand taeglich
        // ansieht. Deshalb sind Ablauf und Projektgrenze hier Pflicht.
        if (body.accountType === 'service') {
          if (body.allowedProjectIds.length === 0) {
            throw new ServiceError(
              'VALIDATION',
              'Fuer Service-Accounts ist eine Projekt-Allowlist verpflichtend.',
              400,
            );
          }
          if (!body.expiresAt) {
            throw new ServiceError(
              'VALIDATION',
              'Fuer Service-Accounts ist ein Ablaufdatum verpflichtend.',
              400,
            );
          }
        }

        const verbindung = await getDb()
          .select()
          .from(jamaConnections)
          .where(eq(jamaConnections.id, body.connectionId))
          .limit(1);
        if (!verbindung[0]) {
          throw new ServiceError('VALIDATION', 'Die angegebene Verbindung existiert nicht.', 400);
        }

        const generated = generateApiKey();
        const [created] = await getDb()
          .insert(apiKeys)
          .values({
            name: body.name,
            owner: body.owner,
            accountType: body.accountType,
            keyHash: generated.hash,
            keyPrefix: generated.prefix,
            connectionId: body.connectionId,
            jamaCredentialsEnc: body.credentials ? encryptCredentials(body.credentials) : null,
            toolsets: ensureCore(body.toolsets),
            allowedProjectIds: body.allowedProjectIds,
            readOnly: body.readOnly,
            rateLimitRps: body.rateLimitRps ?? null,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
            note: body.note ?? null,
          })
          .returning();

        await recordAudit(
          {
            action: 'key.create',
            targetType: 'api_key',
            targetKey: created?.id,
            payload: {
              name: body.name,
              art: body.accountType,
              toolsets: ensureCore(body.toolsets),
              nurLesend: body.readOnly,
              produktiveVerbindung: verbindung[0].isProduction,
            },
            result: 'ok',
          },
          { type: 'admin', ip: clientIp(request) },
        );

        // Der Klartext wird genau hier ein einziges Mal ausgeliefert.
        return {
          id: created?.id,
          name: created?.name,
          apiKey: generated.plaintext,
          hinweis:
            'Dieser Key wird nur jetzt angezeigt. Er ist ausschliesslich als Hash gespeichert und laesst sich nicht wiederherstellen.',
          mcpKonfiguration: mcpClientSnippet(generated.plaintext),
        };
      },
      true,
    ),
  );

  app.patch('/admin/api/keys/:id', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = keySchema
          .partial()
          .extend({ disabled: z.boolean().optional() })
          .parse(request.body);

        const update = baueKeyUpdate(body, encryptCredentials);

        // Die beiden Felder der Personenrechte gehen bewusst an keySchema und
        // baueKeyUpdate vorbei: beim Anlegen eines Zugangs sind sie nicht zu
        // setzen (die Matrix wird nachtraeglich scharf geschaltet), und ein
        // Parse mit keySchema wuerde sie stillschweigend verwerfen. Deshalb ein
        // eigener, schmaler Schnitt auf denselben Rumpf.
        const rechte = z
          .object({
            gesperrteProjektIds: z.array(z.number().int().positive()).max(1000).optional(),
            personenrechteAktiv: z.boolean().optional(),
          })
          .parse(request.body);

        if (rechte.gesperrteProjektIds !== undefined) {
          // Doppelte Nummern aendern an der Wirkung nichts und blaehen nur die
          // Spalte auf; die Sperrliste wird bei jedem Aufruf ausgewertet.
          update.gesperrteProjektIds = [...new Set(rechte.gesperrteProjektIds)];
        }
        if (rechte.personenrechteAktiv !== undefined) {
          update.personenrechteAktiv = rechte.personenrechteAktiv;
        }

        const [updated] = await getDb()
          .update(apiKeys)
          .set(update)
          .where(eq(apiKeys.id, id))
          .returning();

        // Ohne diese Pruefung liefe eine unbekannte ID in einen Zugriff auf
        // undefined und damit in einen 500er, der nach einem Serverfehler
        // aussieht statt nach einem Tippfehler in der Adresse.
        if (!updated) {
          throw new ServiceError('VALIDATION', 'Dieser API-Key existiert nicht.', 404);
        }

        await recordAudit(
          {
            action: 'key.update',
            targetType: 'api_key',
            targetKey: id,
            payload: { felder: Object.keys(update) },
            result: 'ok',
          },
          { type: 'admin', ip: clientIp(request) },
        );

        const { keyHash: _hash, jamaCredentialsEnc: _creds, ...rest } = updated;
        return rest;
      },
      true,
    ),
  );

  app.post('/admin/api/keys/:id/rotate', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const generated = generateApiKey();

        const [updated] = await getDb()
          .update(apiKeys)
          .set({ keyHash: generated.hash, keyPrefix: generated.prefix })
          .where(eq(apiKeys.id, id))
          .returning();

        if (!updated) throw new ServiceError('VALIDATION', 'API-Key nicht gefunden.', 404);

        await recordAudit(
          { action: 'key.rotate', targetType: 'api_key', targetKey: id, result: 'ok' },
          { type: 'admin', ip: clientIp(request) },
        );

        return {
          id,
          apiKey: generated.plaintext,
          hinweis:
            'Der bisherige Key ist ab sofort ungueltig. Alle Clients muessen auf den neuen Wert umgestellt werden.',
          mcpKonfiguration: mcpClientSnippet(generated.plaintext),
        };
      },
      true,
    ),
  );

  app.delete('/admin/api/keys/:id', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        await getDb().delete(apiKeys).where(eq(apiKeys.id, id));
        await recordAudit(
          { action: 'key.delete', targetType: 'api_key', targetKey: id, result: 'ok' },
          { type: 'admin', ip: clientIp(request) },
        );
        return { geloescht: true };
      },
      true,
    ),
  );

  // --- Abgleich, Personen und Rechte ---------------------------------------

  /**
   * Waehlt die Jama-Verbindung fuer den Abgleich.
   *
   * Geraten wird nur dort, wo es nichts zu raten gibt: bei genau einer
   * eingerichteten Verbindung. Sobald mehrere existieren, waere jede Annahme
   * falsch — ein Abgleich gegen die Testinstanz wuerde den Spiegel der
   * Produktivinstanz ueberschreiben und damit jede Zuordnung ins Leere laufen
   * lassen. Dann muss der Aufrufer waehlen.
   */
  const waehleVerbindung = async (gewuenscht?: string) => {
    const spalten = { id: jamaConnections.id, name: jamaConnections.name };

    if (gewuenscht) {
      const rows = await getDb()
        .select(spalten)
        .from(jamaConnections)
        .where(eq(jamaConnections.id, gewuenscht))
        .limit(1);
      const treffer = rows[0];
      if (!treffer) {
        throw new ServiceError('CONNECTION_MISSING', 'Diese Jama-Verbindung existiert nicht.', 404);
      }
      return treffer;
    }

    const alle = await getDb().select(spalten).from(jamaConnections).orderBy(jamaConnections.name);

    if (alle.length === 0) {
      throw new ServiceError(
        'CONNECTION_MISSING',
        'Es ist keine Jama-Verbindung eingerichtet. Ohne sie gibt es nichts abzugleichen.',
        400,
      );
    }
    if (alle.length > 1) {
      throw new ServiceError(
        'VALIDATION',
        'Es sind mehrere Jama-Verbindungen eingerichtet. Bitte die gewünschte Verbindung angeben.',
        400,
        { verbindungen: alle },
      );
    }
    return alle[0]!;
  };

  /**
   * Stoesst den Abgleich des Spiegels an.
   *
   * Die Antwort hat immer dieselbe Form; `fertig` sagt, ob ein Ergebnis
   * vorliegt. So muss die Oberflaeche drei Ausgaenge — abgeschlossen, laeuft
   * bereits, laeuft laenger als die Zeitgrenze — nicht an drei verschiedenen
   * Antwortformen erkennen.
   */
  app.post('/admin/api/abgleich', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const body = z
          .object({ connectionId: z.string().uuid().optional() })
          .parse(request.body ?? {});

        if (laufenderAbgleich) {
          // Ein zweiter Anstoss ist kein Fehler des Aufrufers, sondern eine
          // Frage des Zeitpunkts. Deshalb eine regulaere Antwort mit Hinweis
          // statt eines Fehlerstatus, den die Oberflaeche rot anzeigen wuerde.
          const hinweis =
            'Es läuft bereits ein Abgleich. Bitte dessen Ergebnis abwarten und danach erneut anstoßen.';
          return {
            ...ergebnisOhneLauf(Date.now() - laufenderAbgleich.seit, hinweis),
            gestartet: false,
            fertig: false,
            verbindung: laufenderAbgleich.verbindung,
            hinweis,
          };
        }

        const verbindung = await waehleVerbindung(body.connectionId);
        const von = urheber(request);
        const begonnen = Date.now();

        laufenderAbgleich = { seit: begonnen, verbindung };

        // Die Sperre haengt am tatsaechlichen Lauf, nicht an dieser Antwort:
        // laeuft er nach der Zeitgrenze im Hintergrund weiter, darf trotzdem
        // kein zweiter starten. Der leere Auffangzweig verhindert nur, dass
        // eine abgelehnte Zusage als unbehandelt gilt — gemeldet wird der
        // Fehler ueber das Rennen weiter unten.
        const lauf = gleicheAb(verbindung.id, von).finally(() => {
          laufenderAbgleich = null;
        });
        lauf.catch(() => undefined);

        let zeitgeber: ReturnType<typeof setTimeout> | undefined;
        const zeitgrenze = new Promise<'zeitgrenze'>((aufloesen) => {
          zeitgeber = setTimeout(() => aufloesen('zeitgrenze'), ABGLEICH_ZEITGRENZE_MS);
        });

        try {
          const ausgang = await Promise.race([lauf, zeitgrenze]);
          const dauerMs = Date.now() - begonnen;

          if (ausgang === 'zeitgrenze') {
            const hinweis =
              'Der Abgleich dauert länger als erwartet und läuft im Hintergrund weiter. Der Stand lässt sich über die Abgleichsübersicht abrufen.';
            return {
              ...ergebnisOhneLauf(dauerMs, hinweis),
              gestartet: true,
              fertig: false,
              verbindung,
              hinweis,
            };
          }

          // Das Ergebnis des Dienstes unveraendert, erweitert um das, was nur
          // die Route weiss: dass dieser Aufruf den Lauf angestossen hat und
          // welche Instanz gespiegelt wurde.
          return { ...ausgang, gestartet: true, fertig: true, verbindung, hinweis: null };
        } catch (fehler) {
          throw verdeckeInterna(fehler, 'Der Abgleich ist fehlgeschlagen.');
        } finally {
          // Ohne dies haelt der Zeitgeber den Prozess nach einem schnellen
          // Abgleich noch bis zu zehn Minuten wach.
          if (zeitgeber) clearTimeout(zeitgeber);
        }
      },
      true,
    ),
  );

  app.get('/admin/api/abgleich', async (request, reply) =>
    geschuetzt(request, reply, async () => {
      const stand = await dienst(
        letzterAbgleich(),
        'Der Stand des letzten Abgleichs ließ sich nicht ermitteln.',
      );

      return {
        ...stand,
        laeuft: laufenderAbgleich !== null,
        laeuftSeitMs: laufenderAbgleich ? Date.now() - laufenderAbgleich.seit : null,
      };
    }),
  );

  app.get('/admin/api/personen', async (request, reply) =>
    geschuetzt(request, reply, async () => {
      const query = z
        .object({
          q: suchbegriff,
          nurMitZuordnung: abfrageWahrheit.default(false),
        })
        .parse(request.query ?? {});

      // Die Liste steht in einem benannten Feld, nicht als nackte Sammlung:
      // so laesst sich die Antwort spaeter um Angaben wie eine Gesamtzahl
      // erweitern, ohne dass jeder Aufrufer bricht.
      const personen = await dienst(
        ladePersonen({ q: query.q, nurMitZuordnung: query.nurMitZuordnung }),
        'Die Personenliste ließ sich nicht laden.',
      );
      return { personen };
    }),
  );

  app.get('/admin/api/personen/:jamaUserId', async (request, reply) =>
    geschuetzt(request, reply, async () => {
      const { jamaUserId } = jamaUserIdParam.parse(request.params);

      // Der Spiegel umfasst einige hundert Zeilen; ihn ganz zu laden und die
      // eine Person herauszusuchen ist guenstiger als eine zweite Abfrageform
      // im Dienst, die sonst niemand braucht.
      const [personen, zuordnung] = await Promise.all([
        dienst(ladePersonen(), 'Die Personenliste ließ sich nicht laden.'),
        dienst(ladeZuordnung(jamaUserId), 'Die Zuordnung ließ sich nicht laden.'),
      ]);

      const person = personen.find((zeile) => zeile.jamaUserId === jamaUserId);
      if (!person) {
        throw new ServiceError(
          'VALIDATION',
          'Diese Person ist im Spiegel nicht vorhanden. Bitte zuerst einen Abgleich ausführen.',
          404,
        );
      }

      // Flach statt verschachtelt: die Zuordnung gehoert zur Person, und eine
      // zweite Ebene brachte keine zusaetzliche Aussage.
      return { person, ...zuordnung };
    }),
  );

  /**
   * Setzt die Grundstufe einer Person.
   *
   * Die Grundstufe ist die Abkuerzung fuer den Regelfall: ohne sie muesste
   * jede Person einzeln auf jedes Projekt geklickt werden. Sie erweitert die
   * Rechte nie ueber die Zugangsfreigabe hinaus — das entscheidet die
   * Berechnung, nicht diese Route.
   */
  /**
   * Setzt die Grundstufe fuer alle aktiven Personen auf einmal.
   *
   * Der Weg ohne diesen Knopf: zweihundert Zeilen einzeln anklicken. Der
   * Weg mit ihm: einmal "alle duerfen lesen" setzen und danach die wenigen
   * Ausnahmen pflegen. Genau so ist die Festlegung im Betrieb gemeint, und
   * ohne diese Abkuerzung wird die Matrix schlicht nie eingeschaltet.
   */
  app.put('/admin/api/personen/grundstufe-alle', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const body = z.object({ stufe: stufeSchema }).parse(request.body);

        const betroffene = await dienst(
          setzeGrundstufeFuerAlle(body.stufe, urheber(request)),
          'Die Grundstufe ließ sich nicht für alle setzen.',
        );

        return { betroffene, stufe: body.stufe };
      },
      true,
    ),
  );

  app.put('/admin/api/personen/:jamaUserId/grundstufe', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const { jamaUserId } = jamaUserIdParam.parse(request.params);
        const body = z.object({ stufe: stufeSchema }).parse(request.body);

        // Den Audit-Eintrag schreibt der Dienst selbst, mit genau diesem
        // Urheber. Eine zweite Zeile aus der Route naehme dieselbe Tatsache ein
        // weiteres Mal auf und machte das Protokoll nur unleserlicher.
        await dienst(
          setzeGrundstufe(jamaUserId, body.stufe, urheber(request)),
          'Die Grundstufe ließ sich nicht speichern.',
        );

        return dienst(ladeZuordnung(jamaUserId), 'Die Zuordnung ließ sich nicht laden.');
      },
      true,
    ),
  );

  /**
   * Setzt die Projektzuordnung einer Person in einem Zug.
   *
   * Bewusst als ganze Liste und nicht als einzelne Schalter: die Oberflaeche
   * setzt ueber den Projektbaum oft Dutzende Zeilen gleichzeitig. Einzelne
   * Aufrufe hinterliessen bei einem Abbruch auf halber Strecke einen Zustand,
   * den niemand beabsichtigt hat.
   */
  app.put('/admin/api/personen/:jamaUserId/zuordnung', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const { jamaUserId } = jamaUserIdParam.parse(request.params);
        const body = z
          .object({
            eintraege: z
              .array(z.object({ projectId: z.number().int().positive(), stufe: stufeSchema }))
              .max(
                MAX_ZUORDNUNGSEINTRAEGE,
                `Es sind höchstens ${MAX_ZUORDNUNGSEINTRAEGE} Einträge je Aufruf möglich.`,
              ),
          })
          .parse(request.body);

        // Zwei Eintraege zum selben Projekt widersprechen sich, sobald sie
        // verschiedene Stufen nennen. Welcher gewaenne, waere ein Zufall der
        // Reihenfolge — deshalb abgelehnt statt stillschweigend entschieden.
        const projekte = new Set(body.eintraege.map((eintrag) => eintrag.projectId));
        if (projekte.size !== body.eintraege.length) {
          throw new ServiceError(
            'VALIDATION',
            'Jedes Projekt darf in der Zuordnung nur einmal vorkommen.',
            400,
          );
        }

        // Wie bei der Grundstufe: den Audit-Eintrag schreibt der Dienst, hier
        // wird nur der Urheber hereingereicht.
        await dienst(
          setzeZuordnungMehrfach(jamaUserId, body.eintraege, urheber(request)),
          'Die Zuordnung ließ sich nicht speichern.',
        );

        return dienst(ladeZuordnung(jamaUserId), 'Die Zuordnung ließ sich nicht laden.');
      },
      true,
    ),
  );

  /**
   * Die Projektliste des Spiegels, flach und mit `elternId` je Zeile.
   *
   * Der Baum entsteht in der Oberflaeche: sie zeichnet ihn ohnehin und braucht
   * dafuer keine verschachtelte Antwort, die sich schlechter durchsuchen laesst.
   *
   * Archivierte Projekte bleiben aussen vor, solange nicht ausdruecklich danach
   * gefragt wird — sie sind keine sinnvollen Ziele einer neuen Zuordnung. Mit
   * `mitArchivierten` werden sie sichtbar, sonst bliebe eine alte Zuordnung auf
   * ein inzwischen archiviertes Projekt unsichtbar und damit unloeschbar.
   */
  app.get('/admin/api/projekte', async (request, reply) =>
    geschuetzt(request, reply, async () => {
      const query = z
        .object({
          q: suchbegriff,
          mitArchivierten: abfrageWahrheit.default(false),
        })
        .parse(request.query ?? {});

      const projekte = await dienst(
        ladeProjekte({ q: query.q, mitArchivierten: query.mitArchivierten }),
        'Die Projektliste ließ sich nicht laden.',
      );
      return { projekte };
    }),
  );

  // --- Nutzung und Protokolle ----------------------------------------------

  app.get('/admin/api/usage', async (request, reply) =>
    geschuetzt(request, reply, async () => {
      const filter = zeitraum(request.query);
      const spanneStunden = ((filter.to?.getTime() ?? Date.now()) - filter.from.getTime()) / 3_600_000;

      return {
        zusammenfassung: await usageSummary(filter),
        zeitreihe: await usageTimeline(filter, spanneStunden <= 72 ? 'hour' : 'day'),
        topTools: await topTools(filter, 15),
        topZugaenge: await topKeys(filter, 15),
      };
    }),
  );

  app.get('/admin/api/events', async (request, reply) =>
    geschuetzt(request, reply, async () => {
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(500).default(100), errors: z.coerce.boolean().default(false) })
        .parse(request.query ?? {});
      return recentEvents(query.limit, query.errors);
    }),
  );

  app.get('/admin/api/audit', async (request, reply) =>
    geschuetzt(request, reply, async () => {
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          action: z.string().optional(),
        })
        .parse(request.query ?? {});
      return recentAudit(query.limit, query.action);
    }),
  );

  app.get('/admin/api/audit.csv', async (request, reply) => {
    try {
      await requireSession(request);
      const rows = await recentAudit(5000);
      const kopf = 'Zeitpunkt;Akteur;Art;Aktion;Ziel;Ergebnis;Meldung';
      const zeilen = rows.map((row) =>
        [
          row.ts.toISOString(),
          row.actorName ?? row.actorId ?? '',
          row.actorType,
          row.action,
          row.targetKey ?? '',
          row.result,
          (row.message ?? '').replace(/[;\n\r]/g, ' '),
        ].join(';'),
      );
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="audit.csv"')
        .send([kopf, ...zeilen].join('\n'));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // --- Tool-Katalog ---------------------------------------------------------

  app.get('/admin/api/tools', async (request, reply) =>
    geschuetzt(request, reply, async () => {
      const seit = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const nutzung = await getDb()
        .select({
          tool: usageEvents.toolName,
          aufrufe: sql<number>`count(*)::int`,
          fehler: sql<number>`count(*) filter (where ${usageEvents.status} = 'error')::int`,
          token: sql<number>`coalesce(sum(${usageEvents.estTokens}), 0)::int`,
        })
        .from(usageEvents)
        .where(gte(usageEvents.ts, seit))
        .groupBy(usageEvents.toolName);

      const nachName = new Map(nutzung.map((row) => [row.tool, row]));
      const settings = await getSettings();

      return {
        toolsets: Object.values(TOOLSET_INFO),
        tools: toolCatalog().map((tool) => ({
          ...tool,
          aktiv: !settings.disabledTools.includes(tool.name),
          nutzung30Tage: nachName.get(tool.name) ?? { aufrufe: 0, fehler: 0, token: 0 },
        })),
        prompts: promptCatalog(),
        abgeschaltet: settings.disabledTools,
      };
    }),
  );

  /**
   * Schaltet ein Tool instanzweit ab oder wieder frei. Die Wirkung ist sofort:
   * beim naechsten Verbindungsaufbau eines MCP-Clients wird das Tool nicht mehr
   * registriert, bestehende Verbindungen laufen spaetestens nach Ablauf des
   * Einstellungs-Zwischenspeichers in den Guard.
   */
  app.patch('/admin/api/tools/:name', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const { name } = z.object({ name: z.string() }).parse(request.params);
        const body = z.object({ aktiv: z.boolean() }).parse(request.body);

        if (!getTool(name)) {
          throw new ServiceError('VALIDATION', `Unbekanntes Tool "${name}".`, 404);
        }

        const settings = await getSettings();
        const abgeschaltet = new Set(settings.disabledTools);

        if (body.aktiv) abgeschaltet.delete(name);
        else abgeschaltet.add(name);

        await setSetting('disabledTools', [...abgeschaltet], 'admin');

        await recordAudit(
          {
            action: body.aktiv ? 'tool.enable' : 'tool.disable',
            targetType: 'tool',
            targetKey: name,
            payload: { abgeschalteteTools: abgeschaltet.size },
            result: 'ok',
          },
          { type: 'admin', ip: clientIp(request) },
        );

        return { tool: name, aktiv: body.aktiv, abgeschaltet: [...abgeschaltet] };
      },
      true,
    ),
  );

  /**
   * Fuehrt ein Tool aus dem Admin heraus aus. Zeigt exakt die Antwort, die ein
   * LLM bekaeme, inklusive Token-Schaetzung — das wichtigste Werkzeug, um einen
   * Tool-Zuschnitt zu beurteilen, ohne einen MCP-Client aufzusetzen.
   */
  app.post('/admin/api/tools/:name/try', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const { name } = z.object({ name: z.string() }).parse(request.params);
        const body = z
          .object({ apiKey: z.string().min(1), args: z.record(z.unknown()).default({}) })
          .parse(request.body);

        const tool = getTool(name);
        if (!tool) throw new ServiceError('VALIDATION', `Unbekanntes Tool "${name}".`, 404);

        const resolved = await resolveApiKey(body.apiKey);
        const context = await buildToolContext(resolved);

        // Ein Probelauf ist kein Trockenlauf: schreibende Tools veraendern hier
        // echte Daten. Er muss deshalb genauso protokolliert werden wie ein
        // Aufruf ueber MCP — sonst gaebe es einen Weg, an Nutzungsstatistik und
        // Audit-Trail vorbei zu schreiben. Der Akteur ist dabei der Admin, nicht
        // der Inhaber des verwendeten Keys.
        const auditEintraege: AuditIntent[] = [];
        context.audit = (entry) => auditEintraege.push(entry);

        const gestartet = Date.now();
        let status: 'ok' | 'error' = 'ok';
        let fehlerCode: string | undefined;

        try {
          runGuards(tool, body.args, context);
          const result = await tool.handler(body.args as never, context);
          const text = renderResult(result, context.tokenBudget);

          await protokolliereProbelauf({
            tool,
            args: body.args,
            resolved,
            context,
            auditEintraege,
            dauerMs: Date.now() - gestartet,
            status,
            ip: clientIp(request),
            estTokens: Math.ceil(text.length / 3.6),
            responseBytes: Buffer.byteLength(text, 'utf8'),
          });

          return {
            tool: name,
            dauerMs: Date.now() - gestartet,
            jamaAufrufe: context.client.stats.jamaCalls,
            cacheTreffer: context.client.stats.cacheHits,
            geschaetzteToken: Math.ceil(text.length / 3.6),
            antwort: text,
          };
        } catch (error) {
          status = 'error';
          fehlerCode = toServiceError(error).code;
          await protokolliereProbelauf({
            tool,
            args: body.args,
            resolved,
            context,
            auditEintraege,
            dauerMs: Date.now() - gestartet,
            status,
            fehlerCode,
            ip: clientIp(request),
            estTokens: 0,
            responseBytes: 0,
          });
          throw error;
        }

      },
      true,
    ),
  );

  // --- Einstellungen --------------------------------------------------------

  app.get('/admin/api/settings', async (request, reply) =>
    geschuetzt(request, reply, async () => ({
      einstellungen: await getSettings(),
      sitzungen: (await activeSessions()).map((session) => ({
        id: session.id,
        angelegt: session.createdAt,
        zuletzt: session.lastSeenAt,
        ip: session.ip,
      })),
      publicBaseUrl: getConfig().PUBLIC_BASE_URL,
    })),
  );

  app.patch('/admin/api/settings', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const body = z
          .object({
            globalReadOnly: z.boolean().optional(),
            responseTokenBudget: z.number().int().min(1000).max(200_000).optional(),
            usageRetentionDays: z.number().int().min(1).max(3650).optional(),
          })
          .parse(request.body);

        for (const [key, value] of Object.entries(body)) {
          if (value === undefined) continue;
          await setSetting(key as keyof RuntimeSettings, value as boolean | number, 'admin');
        }

        await recordAudit(
          {
            action: 'settings.update',
            payload: body as Record<string, unknown>,
            result: 'ok',
            message: body.globalReadOnly === true ? 'Globale Notbremse aktiviert' : undefined,
          },
          { type: 'admin', ip: clientIp(request) },
        );

        return getSettings();
      },
      true,
    ),
  );

  app.post('/admin/api/settings/pin', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const body = z
          .object({ neuerPin: z.string().regex(/^\d{8,}$/, 'Mindestens acht Ziffern.') })
          .parse(request.body);

        await setPin(body.neuerPin, 'admin');
        // Nach einer PIN-Aenderung sind alle bestehenden Sitzungen zu beenden —
        // sonst bliebe ein moeglicherweise kompromittierter Zugang offen.
        await logoutAll();

        await recordAudit(
          { action: 'settings.pin.change', result: 'ok' },
          { type: 'admin', ip: clientIp(request) },
        );

        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        reply.clearCookie(CSRF_COOKIE, { path: '/' });

        return {
          geaendert: true,
          hinweis: 'Alle Sitzungen wurden beendet. Bitte mit dem neuen PIN erneut anmelden.',
        };
      },
      true,
    ),
  );

  app.post('/admin/api/cache/clear', async (request, reply) =>
    geschuetzt(
      request,
      reply,
      async () => {
        const vorher = jamaCache.stats();
        jamaCache.clear();
        invalidateSettingsCache();
        await recordAudit(
          { action: 'cache.clear', payload: { eintraege: vorher.entries }, result: 'ok' },
          { type: 'admin', ip: clientIp(request) },
        );
        return { geleert: true, entfernteEintraege: vorher.entries };
      },
      true,
    ),
  );
}


/**
 * Schreibt Nutzung und Audit fuer einen Probelauf aus dem Dashboard.
 *
 * Der Probelauf ist der einzige Weg, ein Tool ausserhalb von MCP auszufuehren.
 * Bliebe er unprotokolliert, gaebe es eine Luecke im Nachweis — gerade dort, wo
 * er am ehesten benutzt wird: beim Ausprobieren schreibender Tools. Die
 * Eintraege sind als Probelauf gekennzeichnet und nennen den Admin als Akteur,
 * damit sie nicht mit regulaeren Aufrufen des Key-Inhabers verwechselt werden.
 */
async function protokolliereProbelauf(vorgang: {
  tool: { name: string; toolset: string; mutating: boolean };
  args: Record<string, unknown>;
  resolved: { key: { id: string; name: string } };
  context: { client: { stats: { jamaCalls: number; cacheHits: number; retries: number } } };
  auditEintraege: AuditIntent[];
  dauerMs: number;
  status: 'ok' | 'error';
  fehlerCode?: string;
  ip: string;
  estTokens: number;
  responseBytes: number;
}): Promise<void> {
  await recordUsage(
    {
      toolName: vorgang.tool.name,
      toolset: vorgang.tool.toolset,
      durationMs: vorgang.dauerMs,
      status: vorgang.status,
      errorCode: vorgang.fehlerCode,
      jamaCalls: vorgang.context.client.stats.jamaCalls,
      cacheHits: vorgang.context.client.stats.cacheHits,
      retries: vorgang.context.client.stats.retries,
      responseBytes: vorgang.responseBytes,
      estTokens: vorgang.estTokens,
      truncated: false,
    },
    { id: vorgang.resolved.key.id, name: `${vorgang.resolved.key.name} (Probelauf)` },
  );

  // Was das Tool selbst zu protokollieren hatte, mit Admin als Akteur.
  for (const eintrag of vorgang.auditEintraege) {
    await recordAudit(eintrag, {
      type: 'admin',
      id: vorgang.resolved.key.id,
      name: `Probelauf ueber Zugang "${vorgang.resolved.key.name}"`,
      ip: vorgang.ip,
    });
  }

  // Zusaetzlich der Probelauf als solcher — auch bei lesenden Tools, damit
  // nachvollziehbar bleibt, wer wann was ausprobiert hat.
  await recordAudit(
    {
      action: 'tool.tryRun',
      targetType: 'tool',
      targetKey: vorgang.tool.name,
      payload: {
        zugang: vorgang.resolved.key.name,
        schreibend: vorgang.tool.mutating,
        argumente: redactArgs(vorgang.args),
      },
      result: vorgang.status,
      message: vorgang.fehlerCode,
    },
    { type: 'admin', ip: vorgang.ip },
  );
}

/** Fertiges Konfigurationsschnipsel fuer die gaengigen MCP-Clients. */
function mcpClientSnippet(apiKey: string): Record<string, unknown> {
  const url = `${getConfig().PUBLIC_BASE_URL.replace(/\/+$/, '')}/mcp`;
  return {
    mcpServers: {
      jama: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    },
  };
}

export { parseToolsets, and };
