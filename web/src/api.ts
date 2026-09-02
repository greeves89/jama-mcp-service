/**
 * Zugriff auf die Admin-API.
 *
 * Der CSRF-Token liegt in einem fuer JavaScript lesbaren Cookie und wird bei
 * jedem veraendernden Aufruf als Header mitgeschickt (Double-Submit-Verfahren).
 */

const CSRF_COOKIE = 'jama_admin_csrf';

function csrfToken(): string {
  const treffer = document.cookie
    .split('; ')
    .find((eintrag) => eintrag.startsWith(`${CSRF_COOKIE}=`));
  return treffer ? decodeURIComponent(treffer.slice(CSRF_COOKIE.length + 1)) : '';
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(pfad: string, init: RequestInit = {}): Promise<T> {
  const veraendernd = init.method !== undefined && init.method !== 'GET';

  // Content-Type NUR bei tatsaechlich vorhandenem Body setzen. Meldet eine
  // Anfrage application/json an, liefert aber nichts mit, weist der Server sie
  // mit 400 ab ("Body cannot be empty when content-type is set"). Das betraf
  // jeden Aufruf ohne Nutzlast — Verbindungstest, Key rotieren, Loeschen,
  // Cache leeren und Abmelden.
  const antwort = await fetch(`/admin/api${pfad}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(veraendernd ? { 'x-csrf-token': csrfToken() } : {}),
      ...init.headers,
    },
  });

  const text = await antwort.text();
  const daten = text ? JSON.parse(text) : undefined;

  if (!antwort.ok) {
    throw new ApiError(
      daten?.fehler ?? `Anfrage fehlgeschlagen (${antwort.status})`,
      antwort.status,
      daten?.code,
    );
  }
  return daten as T;
}

export const api = {
  status: () =>
    request<{
      pinEingerichtet: boolean;
      angemeldet: boolean;
      sperre: { gesperrt: boolean; verbleibendeVersuche: number; gesperrtBisMs?: number };
    }>('/status'),

  login: (pin: string) =>
    request<{ angemeldet: boolean; gueltigBis: string }>('/login', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    }),

  logout: () => request<{ abgemeldet: boolean }>('/logout', { method: 'POST' }),

  overview: () => request<Overview>('/overview'),

  connections: () => request<Connection[]>('/connections'),
  createConnection: (body: unknown) =>
    request<Connection>('/connections', { method: 'POST', body: JSON.stringify(body) }),
  updateConnection: (id: string, body: unknown) =>
    request<Connection>(`/connections/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteConnection: (id: string) =>
    request<{ geloescht: boolean }>(`/connections/${id}`, { method: 'DELETE' }),
  testConnection: (id: string) =>
    request<ConnectionHealth>(`/connections/${id}/test`, { method: 'POST' }),

  keys: () => request<ApiKeyRow[]>('/keys'),
  createKey: (body: unknown) =>
    request<NeuerKey>('/keys', { method: 'POST', body: JSON.stringify(body) }),
  updateKey: (id: string, body: unknown) =>
    request<ApiKeyRow>(`/keys/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  rotateKey: (id: string) => request<NeuerKey>(`/keys/${id}/rotate`, { method: 'POST' }),
  deleteKey: (id: string) => request<{ geloescht: boolean }>(`/keys/${id}`, { method: 'DELETE' }),

  usage: (params: Record<string, string>) =>
    request<UsageReport>(`/usage?${new URLSearchParams(params)}`),
  events: (limit = 100, errors = false) =>
    request<UsageEventRow[]>(`/events?limit=${limit}&errors=${errors}`),
  audit: (limit = 100) => request<AuditRow[]>(`/audit?limit=${limit}`),

  tools: () => request<ToolCatalog>('/tools'),
  setToolActive: (name: string, aktiv: boolean) =>
    request<{ tool: string; aktiv: boolean; abgeschaltet: string[] }>(`/tools/${name}`, {
      method: 'PATCH',
      body: JSON.stringify({ aktiv }),
    }),
  tryTool: (name: string, apiKey: string, args: unknown) =>
    request<ToolTryResult>(`/tools/${name}/try`, {
      method: 'POST',
      body: JSON.stringify({ apiKey, args }),
    }),

  settings: () => request<SettingsResponse>('/settings'),
  updateSettings: (body: unknown) =>
    request<RuntimeSettings>('/settings', { method: 'PATCH', body: JSON.stringify(body) }),
  changePin: (neuerPin: string) =>
    request<{ geaendert: boolean; hinweis: string }>('/settings/pin', {
      method: 'POST',
      body: JSON.stringify({ neuerPin }),
    }),
  clearCache: () =>
    request<{ geleert: boolean; entfernteEintraege: number }>('/cache/clear', { method: 'POST' }),
};

// --- Typen ------------------------------------------------------------------

export interface UsageSummary {
  aufrufe: number;
  fehler: number;
  fehlerquote: number;
  jamaAufrufe: number;
  cacheTreffer: number;
  cacheTrefferquote: number;
  wiederholungen: number;
  geschaetzteToken: number;
  latenzP50: number;
  latenzP95: number;
  latenzP99: number;
}

export interface RuntimeSettings {
  globalReadOnly: boolean;
  responseTokenBudget: number;
  usageRetentionDays: number;
}

export interface Overview {
  gesundheit: {
    datenbank: boolean;
    verbindungen: Array<{
      id: string;
      name: string;
      status: string;
      meldung?: string | null;
      geprueft?: string | null;
      produktiv: boolean;
    }>;
  };
  nutzung: { heute: UsageSummary; woche: UsageSummary; monat: UsageSummary };
  ratenbegrenzung: Record<
    string,
    { availableTokens: number; capacity: number; waiting: number; ratePerSecond: number }
  >;
  cache: { entries: number; hits: number; misses: number; hitRate: number };
  schluessel: {
    gesamt: number;
    aktiv: number;
    ungenutzt: Array<{ id: string; name: string; zuletzt: string | null }>;
  };
  topTools: Array<{ tool: string; aufrufe: number; fehler: number; token: number; p95: number }>;
  letzteFehler: UsageEventRow[];
  einstellungen: RuntimeSettings;
  toolsProToolset: Record<string, number>;
}

export interface Connection {
  id: string;
  name: string;
  baseUrl: string;
  authType: string;
  isProduction: boolean;
  apiVersion: string | null;
  rateLimitRps: number | null;
  healthStatus: string;
  healthMessage: string | null;
  lastHealthCheckAt: string | null;
  createdAt: string;
}

export interface ConnectionHealth {
  ok: boolean;
  message: string;
  user?: string;
  licenseType?: string;
  latencyMs: number;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  owner: string;
  accountType: string;
  keyPrefix: string;
  connectionId: string;
  toolsets: string[];
  allowedProjectIds: number[];
  readOnly: boolean;
  rateLimitRps: number | null;
  expiresAt: string | null;
  disabledAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  note: string | null;
  eigeneCredentials: boolean;
  nutzung30Tage: { aufrufe: number; fehler: number };
}

export interface NeuerKey {
  id: string;
  name: string;
  apiKey: string;
  hinweis: string;
  mcpKonfiguration: unknown;
}

export interface UsageReport {
  zusammenfassung: UsageSummary;
  zeitreihe: Array<{ zeitpunkt: string; aufrufe: number; fehler: number; token: number }>;
  topTools: Array<{ tool: string; aufrufe: number; fehler: number; token: number; p95: number }>;
  topZugaenge: Array<{ zugang: string | null; aufrufe: number; token: number }>;
}

export interface UsageEventRow {
  id: number;
  ts: string;
  apiKeyName: string | null;
  toolName: string;
  toolset: string | null;
  projectId: number | null;
  durationMs: number;
  status: string;
  errorCode: string | null;
  jamaCallCount: number;
  cacheHits: number;
  retries: number;
  estTokens: number;
  truncated: boolean;
}

export interface AuditRow {
  id: number;
  ts: string;
  actorType: string;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetKey: string | null;
  payload: Record<string, unknown> | null;
  result: string;
  message: string | null;
  ip: string | null;
}

export interface ToolCatalog {
  toolsets: Array<{
    id: string;
    label: string;
    description: string;
    mutating: boolean;
    labs: boolean;
  }>;
  tools: Array<{
    name: string;
    title: string;
    toolset: string;
    description: string;
    mutating: boolean;
    destructive: boolean;
    labs: boolean;
    parameters: string[];
    /** false = instanzweit abgeschaltet, wird keinem Client mehr angeboten. */
    aktiv: boolean;
    nutzung30Tage: { aufrufe: number; fehler: number; token: number };
  }>;
  prompts: Array<{ name: string; title: string; requires: string[] }>;
  abgeschaltet: string[];
}

export interface ToolTryResult {
  tool: string;
  dauerMs: number;
  jamaAufrufe: number;
  cacheTreffer: number;
  geschaetzteToken: number;
  antwort: string;
}

export interface SettingsResponse {
  einstellungen: RuntimeSettings;
  sitzungen: Array<{ id: string; angelegt: string; zuletzt: string; ip: string | null }>;
  publicBaseUrl: string;
}
