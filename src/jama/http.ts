import { JamaApiError, ServiceError, explainJamaError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { getAuthHeader, invalidateToken, type JamaCredentials } from './auth.js';
import { RateLimiter, backoffDelayMs } from './rate-limiter.js';

/**
 * HTTP-Kern gegen die Jama-REST-API: Rate-Limiting, Wiederholungen nach 429,
 * Pagination und Fehleruebersetzung. Alles darueber (Tools, Mapping) baut nur
 * noch auf request() und paginate() auf.
 */

/** Jamas Obergrenze fuer maxResults. Groessere Werte werden ignoriert. */
export const JAMA_MAX_PAGE_SIZE = 50;

export interface JamaPageInfo {
  startIndex: number;
  resultCount: number;
  totalResults: number;
}

export interface JamaResponse<T> {
  meta: {
    status?: string;
    timestamp?: string;
    pageInfo?: JamaPageInfo;
  };
  data: T;
  linked?: Record<string, Record<string, unknown>>;
}

/**
 * Zaehlt mit, was ein einzelner Tool-Aufruf tatsaechlich verursacht hat. Diese
 * Werte landen in usage_events und machen im Dashboard sichtbar, welche Tools
 * das Rate-Limit-Budget verbrauchen.
 */
export class CallStats {
  jamaCalls = 0;
  retries = 0;
  cacheHits = 0;
  responseBytes = 0;

  merge(other: CallStats): void {
    this.jamaCalls += other.jamaCalls;
    this.retries += other.retries;
    this.cacheHits += other.cacheHits;
    this.responseBytes += other.responseBytes;
  }
}

export interface JamaHttpOptions {
  baseUrl: string;
  credentials: JamaCredentials;
  rateLimiter: RateLimiter;
  maxRetries: number;
  stats?: CallStats;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** API-Version im Pfad: 'v1' (stabil) oder 'labs' (ohne Support-Zusage). */
  apiVersion?: 'v1' | 'latest' | 'labs';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Mehrfachwerte werden als wiederholte Parameter gesendet (Jama verknuepft sie mit ODER). */
  query?: Record<string, string | number | boolean | (string | number)[] | undefined>;
  body?: unknown;
  /** Ueberschreibt die API-Version fuer diesen einen Aufruf (fuer labs-Endpoints). */
  apiVersion?: 'v1' | 'latest' | 'labs';
  /** Erwartet der Aufrufer eine Binaerantwort (Datei-Download)? */
  raw?: boolean;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class JamaHttp {
  readonly baseUrl: string;
  readonly stats: CallStats;
  private readonly credentials: JamaCredentials;
  private readonly rateLimiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly apiVersion: 'v1' | 'latest' | 'labs';

  constructor(options: JamaHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.credentials = options.credentials;
    this.rateLimiter = options.rateLimiter;
    this.maxRetries = options.maxRetries;
    this.stats = options.stats ?? new CallStats();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.apiVersion = options.apiVersion ?? 'v1';
  }

  private buildUrl(path: string, options: RequestOptions): string {
    const version = options.apiVersion ?? this.apiVersion;
    const clean = path.replace(/^\/+/, '');
    const url = new URL(`${this.baseUrl}/rest/${version}/${clean}`);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        // Jama erwartet wiederholte Parameter statt kommaseparierter Listen.
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.append(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * Einzelner Aufruf inklusive Drosselung und Wiederholung.
   *
   * Wiederholt wird nur bei 429 und bei vorruebergehenden Serverfehlern. Ein
   * 401 wird genau einmal wiederholt, nachdem das gecachte OAuth-Token
   * verworfen wurde — danach ist es ein echtes Berechtigungsproblem und weitere
   * Versuche wuerden nur das Rate-Limit belasten.
   */
  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<JamaResponse<T>> {
    const response = await this.rawRequest(path, options);
    const text = await response.text();
    this.stats.responseBytes += Buffer.byteLength(text, 'utf8');

    if (!text) return { meta: {}, data: undefined as T };

    try {
      return JSON.parse(text) as JamaResponse<T>;
    } catch {
      throw new ServiceError(
        'JAMA_UNEXPECTED',
        `Antwort von Jama war kein JSON (${path}): ${text.slice(0, 200)}`,
        502,
      );
    }
  }

  /** Wie request(), liefert aber die Response — fuer Datei-Downloads. */
  async rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.buildUrl(path, options);
    const method = options.method ?? 'GET';
    let tokenRefreshed = false;

    for (let attempt = 0; ; attempt += 1) {
      await this.rateLimiter.acquire();

      const headers: Record<string, string> = {
        // Bekannte Ungenauigkeit: Muss hier ein neues OAuth-Token geholt werden,
        // laeuft dieser eine Aufruf am Token-Bucket vorbei und wird auch nicht
        // mitgezaehlt. Das Token gilt eine Stunde, also faellt hoechstens ein
        // zusaetzlicher Aufruf je Stunde und Zugangsdatensatz an — gegenueber
        // einem Budget von mehreren Anfragen pro Sekunde nicht relevant.
        Authorization: await getAuthHeader(this.baseUrl, this.credentials, this.fetchImpl),
        Accept: options.raw ? '*/*' : 'application/json',
        // Liefert volle ISO-8601-Zeitstempel statt nur Datumsangaben (ab Jama 8.59).
        'x-jama-date-fields-with-time': 'true',
      };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';

      this.stats.jamaCalls += 1;
      const begonnen = Date.now();

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (attempt < this.maxRetries) {
          this.stats.retries += 1;
          await this.sleep(backoffDelayMs(attempt));
          continue;
        }
        throw new ServiceError('JAMA_UNAVAILABLE', `Jama nicht erreichbar: ${message}`, 502);
      }

      if (response.ok) {
        // Auf "debug" wird jeder Jama-Aufruf sichtbar. Das ist der Schalter fuer
        // die Fehlersuche: ohne ihn ist von aussen nicht erkennbar, welche
        // Adressen dieser Dienst ueberhaupt anspricht und was Jama antwortet.
        // Bewusst nur Metadaten — der Authorization-Header und die Inhalte der
        // Items bleiben aussen vor.
        logger.debug(
          {
            methode: method,
            pfad: path,
            status: response.status,
            dauerMs: Date.now() - begonnen,
            versuch: attempt + 1,
          },
          'Jama-Aufruf',
        );
        return response;
      }

      // Token koennte serverseitig invalidiert worden sein — genau einmal erneuern.
      if (response.status === 401 && !tokenRefreshed) {
        tokenRefreshed = true;
        invalidateToken(this.baseUrl, this.credentials);
        continue;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        this.stats.retries += 1;
        const delay = backoffDelayMs(attempt);
        logger.warn(
          { status: response.status, attempt: attempt + 1, delayMs: delay, path },
          'Jama drosselt oder ist ueberlastet — Wiederholung geplant',
        );
        await this.sleep(delay);
        continue;
      }

      const text = await response.text().catch(() => '');

      // Fehlerhafte Aufrufe erscheinen unabhaengig vom Log-Level, samt der
      // Antwort von Jama: dort steht der eigentliche Grund. Gekuerzt, weil
      // manche Instanzen bei Fehlern eine vollstaendige HTML-Seite liefern.
      logger.warn(
        {
          methode: method,
          pfad: path,
          status: response.status,
          dauerMs: Date.now() - begonnen,
          antwort: text.slice(0, 500),
        },
        'Jama-Aufruf fehlgeschlagen',
      );

      throw new JamaApiError(response.status, explainJamaError(response.status, text), {
        path,
        method,
      });
    }
  }

  /**
   * Laeuft ueber eine paginierte Liste. `limit` ist eine harte Obergrenze —
   * ohne sie koennte ein Projekt mit 5.000 Items 100 Aufrufe ausloesen und
   * allein wegen des Rate-Limits eine Viertelminute blockieren.
   */
  async paginate<T>(
    path: string,
    options: RequestOptions & { limit: number; startAt?: number },
  ): Promise<{ items: T[]; total: number; nextStartAt?: number }> {
    const items: T[] = [];
    let startAt = options.startAt ?? 0;
    let total = 0;

    while (items.length < options.limit) {
      const remaining = options.limit - items.length;
      const pageSize = Math.min(JAMA_MAX_PAGE_SIZE, remaining);

      const response = await this.request<T[]>(path, {
        ...options,
        query: { ...options.query, startAt, maxResults: pageSize },
      });

      const page = Array.isArray(response.data) ? response.data : [];
      items.push(...page);

      const info = response.meta.pageInfo;
      total = info?.totalResults ?? items.length;
      startAt += page.length;

      // Leere Seite oder Ende erreicht.
      if (page.length === 0 || startAt >= total) {
        return { items, total };
      }
    }

    return { items, total, nextStartAt: startAt };
  }

  /**
   * Multipart-Upload. Laeuft bewusst nicht ueber request(), weil dort JSON
   * gesendet wird und der Content-Type inklusive Boundary hier vom FormData
   * gesetzt werden muss. Rate-Limiting, Auth und Fehleruebersetzung gelten aber
   * genauso — deshalb liegt die Methode hier und nicht im Tool.
   */
  async uploadFile(path: string, form: FormData): Promise<Response> {
    await this.rateLimiter.acquire();
    this.stats.jamaCalls += 1;

    const url = this.buildUrl(path, {});
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'PUT',
        headers: {
          Authorization: await getAuthHeader(this.baseUrl, this.credentials, this.fetchImpl),
          Accept: 'application/json',
          // Content-Type absichtlich nicht gesetzt: fetch ergaenzt ihn inklusive Boundary.
        },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (cause) {
      throw new ServiceError(
        'JAMA_UNAVAILABLE',
        `Datei-Upload nach Jama fehlgeschlagen: ${cause instanceof Error ? cause.message : String(cause)}`,
        502,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new JamaApiError(response.status, explainJamaError(response.status, text), { path });
    }
    return response;
  }

  /** Einzelnes Objekt. Ein 404 wird als undefined zurueckgegeben, nicht als Fehler. */
  async getOptional<T>(path: string, options: RequestOptions = {}): Promise<T | undefined> {
    try {
      const response = await this.request<T>(path, options);
      return response.data;
    } catch (error) {
      if (error instanceof JamaApiError && error.jamaStatus === 404) return undefined;
      throw error;
    }
  }
}
