/**
 * TTL-Cache fuer Jama-Stammdaten.
 *
 * Der Cache ist das wirksamste Mittel gegen das 10-req/s-Limit: Projekte,
 * ItemTypes, Picklists und Relationship-Typen werden bei praktisch jedem
 * Tool-Aufruf gebraucht, aendern sich aber selten. Item-INHALTE werden bewusst
 * NICHT gecacht — bei Anforderungen geht Aktualitaet vor Geschwindigkeit.
 *
 * Die Implementierung ist absichtlich prozesslokal. Der Service laeuft zunaechst
 * als einzelner Prozess; das Interface ist so geschnitten, dass ein
 * Redis-Backend spaeter ohne Aenderung an den Aufrufern eingesetzt werden kann.
 */

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export const CACHE_TTL_MS = {
  /** Stammdaten: Projekte, ItemTypes, Picklists, Relationship-Typen, Gruppen. */
  masterData: 6 * 60 * 60 * 1000,
  /** Mittlere Aenderungsrate: Benutzer, Tags, Releases. */
  semiStatic: 60 * 60 * 1000,
  /** OAuth-Token werden anhand von expires_in gesetzt, nicht ueber diese Konstante. */
  short: 5 * 60 * 1000,
} as const;

export class TtlCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /**
   * Holt aus dem Cache oder erzeugt den Wert. Gibt zusaetzlich zurueck, ob es
   * ein Treffer war — der Aufrufer zaehlt das fuer die Cache-Hit-Rate im
   * Dashboard mit.
   */
  async getOrLoad<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<{ value: T; cached: boolean }> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return { value: cached, cached: true };
    const value = await load();
    this.set(key, value, ttlMs);
    return { value, cached: false };
  }

  /** Entfernt alle Eintraege, deren Schluessel mit dem Praefix beginnt. */
  invalidatePrefix(prefix: string): number {
    let removed = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.store.clear();
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 1000) / 10,
    };
  }

  /** Entfernt abgelaufene Eintraege. Wird periodisch aufgerufen. */
  prune(): number {
    const current = this.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= current) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Ein Cache pro Prozess; die Schluessel tragen die Verbindungs-ID als Praefix. */
export const jamaCache = new TtlCache();

export function cacheKey(connectionId: string, ...parts: (string | number)[]): string {
  return `${connectionId}:${parts.join(':')}`;
}
