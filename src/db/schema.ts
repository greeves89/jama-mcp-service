import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Datenmodell nach Konzept Kapitel 6.3.
 *
 * Grundregeln:
 *  - Geheimnisse liegen entweder als Hash (nicht umkehrbar) oder als
 *    AES-256-GCM-Umschlag (Spaltenname endet auf _enc) vor. Nie im Klartext.
 *  - usage_events und audit_log sind reine Append-Tabellen.
 */

export const jamaConnections = pgTable('jama_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  /** 'oauth' | 'basic' */
  authType: text('auth_type').notNull(),
  /** AES-256-GCM-Umschlag ueber { clientId, clientSecret } bzw. { username, password }. */
  credentialsEnc: text('credentials_enc').notNull(),
  /**
   * Produktionsverbindungen werden im Admin rot markiert und erfordern beim
   * Zuordnen zu einem schreibenden Key eine zusaetzliche Bestaetigung.
   */
  isProduction: boolean('is_production').notNull().default(false),
  /** Aus GET /rest ermittelt. */
  apiVersion: text('api_version'),
  /** Ergebnis der Feature-Erkennung, u. a. ob labs-Endpoints verfuegbar sind. */
  capabilities: jsonb('capabilities').$type<Record<string, unknown>>(),
  /** Eigenes Rate-Limit; greift der Wert nicht, gilt JAMA_RATE_LIMIT_RPS. */
  rateLimitRps: real('rate_limit_rps'),
  healthStatus: text('health_status').notNull().default('unknown'),
  healthMessage: text('health_message'),
  lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    owner: text('owner').notNull(),
    /** 'user' | 'service' — Service-Accounts unterliegen strengeren Pflichtfeldern. */
    accountType: text('account_type').notNull().default('user'),
    /** SHA-256 des vollstaendigen Keys. Der Key selbst wird nie gespeichert. */
    keyHash: text('key_hash').notNull(),
    /** Nicht geheimes Praefix zur Wiedererkennung. */
    keyPrefix: text('key_prefix').notNull(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => jamaConnections.id, { onDelete: 'restrict' }),
    /**
     * Jama-Zugangsdaten dieses Keys. Ist der Wert leer, werden die Credentials
     * der Verbindung benutzt (Service-Account-Fall).
     */
    jamaCredentialsEnc: text('jama_credentials_enc'),
    toolsets: text('toolsets').array().notNull(),
    /** Leer bedeutet: alle Projekte, die der Jama-Benutzer ohnehin sehen darf. */
    allowedProjectIds: integer('allowed_project_ids').array().notNull().default([]),
    /**
     * Sperrliste. Gilt unabhaengig von allen Freigaben und hebt nie etwas auf.
     * Gedacht fuer Bereiche, die ueber diese Anbindung niemand sehen soll.
     */
    gesperrteProjektIds: integer('gesperrte_projekt_ids').array().notNull().default([]),
    /**
     * Schaltet die personenbezogene Matrix fuer diesen Zugang scharf. Bewusst
     * je Zugang und mit false als Vorgabe: ein bestehender Zugang laeuft
     * unveraendert weiter, bis er umgestellt wird.
     */
    personenrechteAktiv: boolean('personenrechte_aktiv').notNull().default(false),
    readOnly: boolean('read_only').notNull().default(true),
    rateLimitRps: real('rate_limit_rps'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by').notNull().default('admin'),
    note: text('note'),
  },
  (table) => [
    uniqueIndex('api_keys_key_hash_idx').on(table.keyHash),
    uniqueIndex('api_keys_key_prefix_idx').on(table.keyPrefix),
    index('api_keys_connection_idx').on(table.connectionId),
  ],
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    /** Redundant gespeichert, damit die Auswertung nach Key-Loeschung erhalten bleibt. */
    apiKeyName: text('api_key_name'),
    toolName: text('tool_name').notNull(),
    toolset: text('toolset'),
    projectId: integer('project_id'),
    durationMs: integer('duration_ms').notNull(),
    /** 'ok' | 'error' */
    status: text('status').notNull(),
    errorCode: text('error_code'),
    /** Wie viele echte HTTP-Aufrufe an Jama dieser Tool-Aufruf ausgeloest hat. */
    jamaCallCount: integer('jama_call_count').notNull().default(0),
    cacheHits: integer('cache_hits').notNull().default(0),
    retries: integer('retries').notNull().default(0),
    responseBytes: integer('response_bytes').notNull().default(0),
    estTokens: integer('est_tokens').notNull().default(0),
    truncated: boolean('truncated').notNull().default(false),
  },
  (table) => [
    index('usage_events_ts_idx').on(table.ts),
    index('usage_events_key_ts_idx').on(table.apiKeyId, table.ts),
    index('usage_events_tool_ts_idx').on(table.toolName, table.ts),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    /** 'api_key' | 'admin' | 'system' */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    actorName: text('actor_name'),
    /** z. B. 'item.create', 'key.rotate', 'admin.login.failed' */
    action: text('action').notNull(),
    targetType: text('target_type'),
    /** Document Key oder ID des betroffenen Objekts. */
    targetKey: text('target_key'),
    /** Parameter mit redigierten Geheimnissen. */
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    /** 'ok' | 'error' | 'denied' */
    result: text('result').notNull(),
    message: text('message'),
    ip: text('ip'),
  },
  (table) => [
    index('audit_log_ts_idx').on(table.ts),
    index('audit_log_action_ts_idx').on(table.action, table.ts),
    index('audit_log_target_idx').on(table.targetKey),
  ],
);

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [
    uniqueIndex('admin_sessions_token_idx').on(table.tokenHash),
    index('admin_sessions_expires_idx').on(table.expiresAt),
  ],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    ip: text('ip').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    success: boolean('success').notNull(),
  },
  (table) => [index('login_attempts_ip_ts_idx').on(table.ip, table.ts)],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

/**
 * Spiegel der Jama-Benutzer.
 *
 * Bewusst ein Spiegel und keine Quelle: Jama bleibt fuehrend, hier wird nur
 * nachgeschrieben. Ohne diesen Spiegel muesste jede Ansicht der
 * Rechtezuordnung die Benutzerliste live aus Jama holen — ein Aufruf ueber die
 * gesamte Instanz, der gegen das Rate-Limit zaehlt und beim Blaettern durch
 * eine Liste nicht zu bezahlen ist.
 */
export const jamaBenutzer = pgTable(
  'jama_benutzer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Die Nummer aus Jama. Sie ist der Bezugspunkt der Rechtezuordnung. */
    jamaUserId: integer('jama_user_id').notNull(),
    username: text('username'),
    email: text('email'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    /** 'CREATOR' | 'FLOAT' | 'STAKEHOLDER' | 'REVIEWER' | weitere. */
    licenseType: text('license_type'),
    /**
     * In Jama deaktiviert oder dort nicht mehr auffindbar. Der Datensatz bleibt
     * stehen: eine geloeschte Zeile wuerde die Zuordnung ihres Bezugspunkts
     * berauben und die Nachvollziehbarkeit mit sich nehmen.
     */
    aktiv: boolean('aktiv').notNull().default(true),
    abgeglichenAm: timestamp('abgeglichen_am', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('jama_benutzer_user_idx').on(table.jamaUserId),
    index('jama_benutzer_aktiv_idx').on(table.aktiv),
  ],
);

/**
 * Spiegel der Jama-Projekte, aus demselben Grund wie der Benutzerspiegel.
 *
 * elternId traegt die Jama-Projektnummer des uebergeordneten Ordners. Der Baum
 * wird daraus erst in der Oberflaeche gebaut; die Tabelle haelt bewusst nur die
 * flache Kante, weil jede vorberechnete Baumstruktur beim naechsten Umhaengen
 * in Jama falsch waere.
 */
export const jamaProjekte = pgTable(
  'jama_projekte',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jamaProjectId: integer('jama_project_id').notNull(),
    projectKey: text('project_key'),
    name: text('name'),
    /** Jama-Projektnummer des Ordners darueber; null bei einer Wurzel. */
    elternId: integer('eltern_id'),
    istOrdner: boolean('ist_ordner').notNull().default(false),
    /** Gesetzt, sobald Jama das Projekt nicht mehr liefert. Nie geloescht. */
    archiviert: boolean('archiviert').notNull().default(false),
    abgeglichenAm: timestamp('abgeglichen_am', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('jama_projekte_project_idx').on(table.jamaProjectId),
    index('jama_projekte_eltern_idx').on(table.elternId),
  ],
);

/**
 * Die Zuordnung Person zu Projekt.
 *
 * Beide Spalten tragen die Jama-Nummer und nicht die uuid des Spiegels. Das ist
 * der Kern der Entscheidung: der Spiegel ist jederzeit verwerfbar und neu
 * aufbaubar, seine uuids sind es damit auch. Haengte die Zuordnung daran, waere
 * sie nach dem ersten Neuaufbau verloren. Die Jama-Nummer ueberlebt ihn.
 * Aus demselben Grund steht hier bewusst kein Fremdschluessel auf den Spiegel:
 * er wuerde genau das Loeschen und Neuaufbauen verhindern oder die Zuordnung
 * mitreissen.
 */
export const personenrechte = pgTable(
  'personenrechte',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jamaUserId: integer('jama_user_id').notNull(),
    jamaProjectId: integer('jama_project_id').notNull(),
    /** 'lesen' | 'schreiben'. 'keine' wird nicht gespeichert, sondern geloescht. */
    stufe: text('stufe').notNull(),
    vergebenAm: timestamp('vergeben_am', { withTimezone: true }).notNull().defaultNow(),
    vergebenVon: text('vergeben_von'),
  },
  (table) => [
    uniqueIndex('personenrechte_person_projekt_idx').on(table.jamaUserId, table.jamaProjectId),
    index('personenrechte_person_idx').on(table.jamaUserId),
    index('personenrechte_projekt_idx').on(table.jamaProjectId),
  ],
);

/**
 * Grundstufe je Person, damit nicht jede Person einzeln an jedes Projekt
 * geklickt werden muss. Sie wirkt nur innerhalb der Grenzen des Zugangs und
 * kann diese nie ausweiten.
 */
export const personenvorgabe = pgTable('personenvorgabe', {
  jamaUserId: integer('jama_user_id').primaryKey(),
  /** 'keine' | 'lesen' | 'schreiben'. */
  grundstufe: text('grundstufe').notNull().default('lesen'),
  notiz: text('notiz'),
});

export type JamaConnection = typeof jamaConnections.$inferSelect;
export type NewJamaConnection = typeof jamaConnections.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
export type AdminSession = typeof adminSessions.$inferSelect;
export type JamaBenutzer = typeof jamaBenutzer.$inferSelect;
export type NewJamaBenutzer = typeof jamaBenutzer.$inferInsert;
export type JamaProjektSpiegel = typeof jamaProjekte.$inferSelect;
export type NewJamaProjektSpiegel = typeof jamaProjekte.$inferInsert;
export type Personenrecht = typeof personenrechte.$inferSelect;
export type NewPersonenrecht = typeof personenrechte.$inferInsert;
export type Personenvorgabe = typeof personenvorgabe.$inferSelect;
export type NewPersonenvorgabe = typeof personenvorgabe.$inferInsert;
