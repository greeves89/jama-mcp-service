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
  topKeys,
  topTools,
  usageSummary,
  usageTimeline,
} from '../service/usage.js';
import { generateApiKey } from '../shared/crypto.js';
import { getConfig } from '../shared/config.js';
import { ServiceError, toServiceError } from '../shared/errors.js';
import { DEFAULT_TOOLSETS, TOOLSET_INFO, TOOLSETS, parseToolsets } from '../shared/toolsets.js';
import { promptCatalog } from '../mcp/prompts.js';
import { toolCatalog, toolCountByToolset, getTool } from '../mcp/registry.js';
import { jamaCache } from '../jama/cache.js';
import { rateLimiterSnapshots } from '../jama/rate-limiter.js';
import { checkConnection, JamaClient } from '../jama/client.js';
import { jamaCredentialsSchema } from '../jama/auth.js';
import { buildToolContext, resolveApiKey } from '../service/keys.js';
import { runGuards } from '../mcp/guards.js';
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
  return reply
    .status(serviceError.httpStatus)
    .send({ fehler: serviceError.message, code: serviceError.code, details: serviceError.details });
}

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

        const update: Record<string, unknown> = {};
        if (body.name !== undefined) update.name = body.name;
        if (body.baseUrl !== undefined) update.baseUrl = body.baseUrl.replace(/\/+$/, '');
        if (body.isProduction !== undefined) update.isProduction = body.isProduction;
        if (body.rateLimitRps !== undefined) update.rateLimitRps = body.rateLimitRps;
        if (body.credentials !== undefined) {
          update.credentialsEnc = encryptCredentials(body.credentials);
          update.authType = body.credentials.type;
        }

        const [updated] = await getDb()
          .update(jamaConnections)
          .set(update)
          .where(eq(jamaConnections.id, id))
          .returning();

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

        const { credentialsEnc: _unused, ...rest } = updated!;
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
            `Die Verbindung wird noch von ${anzahl} API-Keys genutzt. Diese zuerst loeschen oder umhaengen.`,
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
    credentials: jamaCredentialsSchema.optional(),
    toolsets: z.array(z.enum(TOOLSETS)).default(DEFAULT_TOOLSETS),
    allowedProjectIds: z.array(z.number().int()).default([]),
    readOnly: z.boolean().default(true),
    rateLimitRps: z.number().min(0.5).max(10).optional(),
    expiresAt: z.string().optional(),
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
            toolsets: body.toolsets,
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
              toolsets: body.toolsets,
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

        const update: Record<string, unknown> = {};
        if (body.name !== undefined) update.name = body.name;
        if (body.owner !== undefined) update.owner = body.owner;
        if (body.toolsets !== undefined) update.toolsets = body.toolsets;
        if (body.allowedProjectIds !== undefined) update.allowedProjectIds = body.allowedProjectIds;
        if (body.readOnly !== undefined) update.readOnly = body.readOnly;
        if (body.rateLimitRps !== undefined) update.rateLimitRps = body.rateLimitRps;
        if (body.expiresAt !== undefined) update.expiresAt = new Date(body.expiresAt);
        if (body.note !== undefined) update.note = body.note;
        if (body.credentials !== undefined) {
          update.jamaCredentialsEnc = encryptCredentials(body.credentials);
        }
        if (body.disabled !== undefined) {
          update.disabledAt = body.disabled ? new Date() : null;
        }

        const [updated] = await getDb()
          .update(apiKeys)
          .set(update)
          .where(eq(apiKeys.id, id))
          .returning();

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

        const { keyHash: _hash, jamaCredentialsEnc: _creds, ...rest } = updated!;
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

      return {
        toolsets: Object.values(TOOLSET_INFO),
        tools: toolCatalog().map((tool) => ({
          ...tool,
          nutzung30Tage: nachName.get(tool.name) ?? { aufrufe: 0, fehler: 0, token: 0 },
        })),
        prompts: promptCatalog(),
      };
    }),
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

        const gestartet = Date.now();
        runGuards(tool, body.args, context);
        const result = await tool.handler(body.args as never, context);
        const text = renderResult(result, context.tokenBudget);

        return {
          tool: name,
          dauerMs: Date.now() - gestartet,
          jamaAufrufe: context.client.stats.jamaCalls,
          cacheTreffer: context.client.stats.cacheHits,
          geschaetzteToken: Math.ceil(text.length / 3.6),
          antwort: text,
        };
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
