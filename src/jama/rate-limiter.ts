/**
 * Token-Bucket pro Jama-Verbindung.
 *
 * Jama drosselt bei 10 Requests pro Sekunde — und zwar fuer die GESAMTE Instanz,
 * nicht pro Benutzer. Ein MCP-Server, der naiv parallelisiert, legt damit auch
 * alle anderen Integrationen des Kunden lahm. Der Bucket haengt deshalb bewusst
 * an der Verbindung und nicht am API-Key, und der Default liegt unter dem
 * Limit, um Luft fuer Fremdintegrationen zu lassen.
 */

export interface RateLimiterOptions {
  /** Nachfuellrate in Anfragen pro Sekunde. */
  ratePerSecond: number;
  /** Maximale Burst-Groesse. Default: eine Sekunde Nachschub. */
  burst?: number;
  /** Injizierbar fuer Tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly ratePerSecond: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /**
   * Serialisiert die Wartenden. Ohne diese Kette wuerden bei gleichzeitigem
   * Andrang alle Aufrufer dieselbe Luecke sehen und gemeinsam losstuermen.
   */
  private queue: Promise<void> = Promise.resolve();
  private waiting = 0;

  constructor(options: RateLimiterOptions) {
    this.ratePerSecond = options.ratePerSecond;
    this.burst = options.burst ?? Math.max(1, Math.ceil(options.ratePerSecond));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const current = this.now();
    const elapsedSeconds = (current - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefill = current;
  }

  /** Wartet, bis ein Token verfuegbar ist, und verbraucht es. */
  async acquire(): Promise<void> {
    this.waiting += 1;
    const turn = this.queue.then(async () => {
      this.refill();
      while (this.tokens < 1) {
        const deficit = 1 - this.tokens;
        const waitMs = Math.max(5, Math.ceil((deficit / this.ratePerSecond) * 1000));
        await this.sleep(waitMs);
        this.refill();
      }
      this.tokens -= 1;
    });

    // Auch bei Fehlern muss die Kette weiterlaufen, sonst blockiert der Bucket dauerhaft.
    this.queue = turn.then(
      () => undefined,
      () => undefined,
    );

    try {
      await turn;
    } finally {
      this.waiting -= 1;
    }
  }

  /** Momentaufnahme fuer die Auslastungsanzeige im Admin-Dashboard. */
  snapshot(): { availableTokens: number; capacity: number; waiting: number; ratePerSecond: number } {
    this.refill();
    return {
      availableTokens: Math.floor(this.tokens * 100) / 100,
      capacity: this.burst,
      waiting: this.waiting,
      ratePerSecond: this.ratePerSecond,
    };
  }
}

/**
 * Wartezeiten nach HTTP 429. Jama empfiehlt ausdruecklich einen Fibonacci-artigen
 * Verlauf (3, 5, 8, 13 Sekunden). Der Jitter verhindert, dass mehrere Clients
 * nach derselben Drosselung im Gleichschritt erneut anklopfen.
 */
export const BACKOFF_SECONDS = [3, 5, 8, 13, 21] as const;

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(attempt, BACKOFF_SECONDS.length - 1);
  const base = BACKOFF_SECONDS[index] ?? 21;
  const jitter = 0.8 + random() * 0.4; // +/- 20 Prozent
  return Math.round(base * 1000 * jitter);
}

const limiters = new Map<string, RateLimiter>();

/**
 * Liefert den Bucket einer Verbindung. Wird die Rate im Admin geaendert, wird
 * der Bucket neu aufgebaut — der kurze Verlust des Fuellstands ist unkritisch.
 */
export function getRateLimiter(connectionId: string, ratePerSecond: number): RateLimiter {
  const key = `${connectionId}:${ratePerSecond}`;
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new RateLimiter({ ratePerSecond });
    // Alte Buckets derselben Verbindung mit anderer Rate entfernen.
    for (const existing of limiters.keys()) {
      if (existing.startsWith(`${connectionId}:`) && existing !== key) limiters.delete(existing);
    }
    limiters.set(key, limiter);
  }
  return limiter;
}

export function rateLimiterSnapshots(): Record<string, ReturnType<RateLimiter['snapshot']>> {
  const result: Record<string, ReturnType<RateLimiter['snapshot']>> = {};
  for (const [key, limiter] of limiters) {
    const connectionId = key.split(':')[0] ?? key;
    result[connectionId] = limiter.snapshot();
  }
  return result;
}

export function resetRateLimiters(): void {
  limiters.clear();
}
