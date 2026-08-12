import { describe, expect, it, vi } from 'vitest';
import { CallStats, JamaHttp } from '../src/jama/http.js';
import { RateLimiter } from '../src/jama/rate-limiter.js';
import { clearTokenCache, getAuthHeader } from '../src/jama/auth.js';
import { JamaApiError } from '../src/shared/errors.js';

/**
 * Der HTTP-Kern gegen einen fetch-Doppelgaenger. Geprueft wird das Verhalten,
 * auf das sich alle Tools verlassen: Wiederholung nach Drosselung, Pagination
 * mit Jamas Seitengrenze von 50, und die Uebersetzung von Fehlern in
 * Meldungen, mit denen ein LLM etwas anfangen kann.
 */

function antwort(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function baueClient(fetchImpl: typeof fetch, maxRetries = 2) {
  const stats = new CallStats();
  return {
    stats,
    http: new JamaHttp({
      baseUrl: 'https://beispiel.jamacloud.com',
      credentials: { type: 'basic', username: 'u', password: 'p' },
      rateLimiter: new RateLimiter({ ratePerSecond: 1000 }),
      maxRetries,
      stats,
      fetchImpl,
      sleep: async () => undefined,
    }),
  };
}

describe('Aufbau der Anfragen', () => {
  it('setzt den Versionspfad und den Zeitstempel-Header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(antwort(200, { data: [] }));
    const { http } = baueClient(fetchImpl as unknown as typeof fetch);

    await http.request('projects');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('/rest/v1/projects');
    expect((init.headers as Record<string, string>)['x-jama-date-fields-with-time']).toBe('true');
  });

  it('sendet Mehrfachwerte als wiederholte Parameter, wie Jama sie erwartet', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(antwort(200, { data: [] }));
    const { http } = baueClient(fetchImpl as unknown as typeof fetch);

    await http.request('abstractitems', { query: { itemType: [1, 2, 3] } });

    const url = String(fetchImpl.mock.calls[0]![0]);
    // Nicht "itemType=1,2,3" — das wuerde Jama als einen Wert lesen.
    expect(url).toContain('itemType=1&itemType=2&itemType=3');
  });

  it('waehlt den labs-Pfad, wenn das Tool ihn anfordert', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(antwort(200, { data: [] }));
    const { http } = baueClient(fetchImpl as unknown as typeof fetch);

    await http.request('reviews', { apiVersion: 'labs' });

    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/rest/labs/reviews');
  });
});

describe('Verhalten bei Drosselung', () => {
  it('wiederholt nach 429 und liefert am Ende das Ergebnis', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(antwort(429, { error: 'throttled' }))
      .mockResolvedValueOnce(antwort(429, { error: 'throttled' }))
      .mockResolvedValueOnce(antwort(200, { data: { id: 1 } }));

    const { http, stats } = baueClient(fetchImpl as unknown as typeof fetch);
    const ergebnis = await http.request<{ id: number }>('items/1');

    expect(ergebnis.data).toEqual({ id: 1 });
    expect(stats.retries).toBe(2);
    expect(stats.jamaCalls).toBe(3);
  });

  it('gibt nach erschoepften Versuchen auf und erklaert das Limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(antwort(429, { error: 'throttled' }));
    const { http } = baueClient(fetchImpl as unknown as typeof fetch, 2);

    await expect(http.request('items/1')).rejects.toThrow(JamaApiError);
    // Erstversuch plus zwei Wiederholungen.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('wiederholt auch bei Serverfehlern', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(antwort(503, 'nicht verfuegbar'))
      .mockResolvedValueOnce(antwort(200, { data: [] }));

    const { http } = baueClient(fetchImpl as unknown as typeof fetch);
    await expect(http.request('projects')).resolves.toBeDefined();
  });

  it('wiederholt NICHT bei einem 404', async () => {
    // Ein fehlendes Objekt wird durch Wiederholen nicht existent — jeder weitere
    // Versuch verbraucht nur Budget gegen das Rate-Limit.
    const fetchImpl = vi.fn().mockResolvedValue(antwort(404, { error: 'not found' }));
    const { http } = baueClient(fetchImpl as unknown as typeof fetch);

    await expect(http.request('items/999')).rejects.toThrow(JamaApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('wiederholt NICHT bei einem 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(antwort(400, { error: 'bad field' }));
    const { http } = baueClient(fetchImpl as unknown as typeof fetch);

    await expect(http.request('items', { method: 'POST', body: {} })).rejects.toThrow(JamaApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Umgang mit abgelaufenen Anmeldungen', () => {
  it('erneuert bei einem 401 genau einmal und gibt dann auf', async () => {
    clearTokenCache();
    const fetchImpl = vi.fn().mockResolvedValue(antwort(401, { error: 'unauthorized' }));
    const { http } = baueClient(fetchImpl as unknown as typeof fetch, 3);

    await expect(http.request('users/current')).rejects.toThrow(JamaApiError);
    // Erstversuch plus ein Versuch nach dem Verwerfen des Tokens — nicht mehr.
    // Bei echten Berechtigungsproblemen wuerde jede weitere Runde nur schaden.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('Pagination', () => {
  it('holt weitere Seiten, bis das Limit erreicht ist', async () => {
    const seite = (start: number, anzahl: number, gesamt: number) =>
      antwort(200, {
        meta: { pageInfo: { startIndex: start, resultCount: anzahl, totalResults: gesamt } },
        data: Array.from({ length: anzahl }, (_, index) => ({ id: start + index })),
      });

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(seite(0, 50, 120))
      .mockResolvedValueOnce(seite(50, 50, 120))
      .mockResolvedValueOnce(seite(100, 20, 120));

    const { http } = baueClient(fetchImpl as unknown as typeof fetch);
    const ergebnis = await http.paginate<{ id: number }>('items', { limit: 200 });

    expect(ergebnis.items).toHaveLength(120);
    expect(ergebnis.total).toBe(120);
    expect(ergebnis.nextStartAt).toBeUndefined();
  });

  it('haelt Jamas Seitengrenze von 50 ein', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      antwort(200, {
        meta: { pageInfo: { startIndex: 0, resultCount: 50, totalResults: 50 } },
        data: Array.from({ length: 50 }, (_, index) => ({ id: index })),
      }),
    );

    const { http } = baueClient(fetchImpl as unknown as typeof fetch);
    await http.paginate('items', { limit: 500 });

    // Groessere Werte wuerde Jama stillschweigend auf 50 kappen — dann waere die
    // Fortschrittsrechnung falsch.
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('maxResults=50');
  });

  it('meldet den naechsten Versatz, wenn das Limit vor dem Ende greift', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      antwort(200, {
        meta: { pageInfo: { startIndex: 0, resultCount: 10, totalResults: 500 } },
        data: Array.from({ length: 10 }, (_, index) => ({ id: index })),
      }),
    );

    const { http } = baueClient(fetchImpl as unknown as typeof fetch);
    const ergebnis = await http.paginate('items', { limit: 10 });

    expect(ergebnis.nextStartAt).toBe(10);
    expect(ergebnis.total).toBe(500);
  });

  it('bricht bei einer leeren Seite ab, statt endlos zu blaettern', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      antwort(200, {
        meta: { pageInfo: { startIndex: 0, resultCount: 0, totalResults: 999 } },
        data: [],
      }),
    );

    const { http } = baueClient(fetchImpl as unknown as typeof fetch);
    const ergebnis = await http.paginate('items', { limit: 500 });

    expect(ergebnis.items).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Fehlermeldungen fuer das Sprachmodell', () => {
  it('erklaert bei einem 400 den Umgang mit Custom Fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(antwort(400, { error: 'unknown field' }));
    const { http } = baueClient(fetchImpl as unknown as typeof fetch);

    await expect(http.request('items', { method: 'POST' })).rejects.toThrow(
      /jama_get_project_schema/,
    );
  });

  it('weist bei einem 401 auf die Lizenzanforderung hin', async () => {
    clearTokenCache();
    const fetchImpl = vi.fn().mockResolvedValue(antwort(401, {}));
    const { http } = baueClient(fetchImpl as unknown as typeof fetch, 0);

    await expect(http.request('users/current')).rejects.toThrow(/Named-Creator/);
  });

  it('liefert bei einem 404 undefined statt eines Fehlers, wo das gewollt ist', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(antwort(404, {}));
    const { http } = baueClient(fetchImpl as unknown as typeof fetch);

    await expect(http.getOptional('items/999')).resolves.toBeUndefined();
  });
});

describe('OAuth-Token', () => {
  it('holt ein Token und benutzt es beim naechsten Mal aus dem Zwischenspeicher', async () => {
    clearTokenCache();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(antwort(200, { access_token: 'abc123', expires_in: 3600 }));

    const credentials = { type: 'oauth' as const, clientId: 'id', clientSecret: 'secret' };
    const erste = await getAuthHeader(
      'https://beispiel.jamacloud.com',
      credentials,
      fetchImpl as unknown as typeof fetch,
    );
    const zweite = await getAuthHeader(
      'https://beispiel.jamacloud.com',
      credentials,
      fetchImpl as unknown as typeof fetch,
    );

    expect(erste).toBe('Bearer abc123');
    expect(zweite).toBe('Bearer abc123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('baut den Basic-Header ohne Netzzugriff', async () => {
    const fetchImpl = vi.fn();
    const header = await getAuthHeader(
      'https://beispiel.jamacloud.com',
      { type: 'basic', username: 'u', password: 'p' },
      fetchImpl as unknown as typeof fetch,
    );

    expect(header).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
