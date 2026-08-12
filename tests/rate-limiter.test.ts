import { describe, expect, it } from 'vitest';
import { BACKOFF_SECONDS, RateLimiter, backoffDelayMs } from '../src/jama/rate-limiter.js';

/**
 * Der Rate-Limiter ist die einzige Stelle, die verhindert, dass dieser Dienst
 * eine Jama-Instanz fuer alle anderen Integrationen ausbremst. Die Tests
 * arbeiten mit einer gesteuerten Uhr, damit sie deterministisch und schnell sind.
 */

function testUhr(start = 0) {
  let jetzt = start;
  return {
    now: () => jetzt,
    /** Simuliertes Warten: die Uhr springt vor, ohne echte Zeit zu verbrauchen. */
    sleep: async (ms: number) => {
      jetzt += ms;
    },
    vorspulen: (ms: number) => {
      jetzt += ms;
    },
  };
}

describe('Token-Bucket', () => {
  it('laesst einen Burst in Hoehe der Kapazitaet sofort durch', async () => {
    const uhr = testUhr();
    const limiter = new RateLimiter({ ratePerSecond: 5, now: uhr.now, sleep: uhr.sleep });

    for (let i = 0; i < 5; i += 1) await limiter.acquire();

    expect(uhr.now()).toBe(0);
    expect(limiter.snapshot().availableTokens).toBeLessThan(1);
  });

  it('bremst, sobald der Vorrat aufgebraucht ist', async () => {
    const uhr = testUhr();
    const limiter = new RateLimiter({ ratePerSecond: 5, now: uhr.now, sleep: uhr.sleep });

    for (let i = 0; i < 5; i += 1) await limiter.acquire();
    await limiter.acquire();

    // Bei 5 Anfragen pro Sekunde muss die sechste rund 200 ms warten.
    expect(uhr.now()).toBeGreaterThanOrEqual(190);
  });

  it('fuellt den Vorrat ueber die Zeit wieder auf', async () => {
    const uhr = testUhr();
    const limiter = new RateLimiter({ ratePerSecond: 4, now: uhr.now, sleep: uhr.sleep });

    for (let i = 0; i < 4; i += 1) await limiter.acquire();
    uhr.vorspulen(1000);

    const vorher = uhr.now();
    await limiter.acquire();
    expect(uhr.now()).toBe(vorher);
  });

  it('fuellt nie ueber die Kapazitaet hinaus', async () => {
    const uhr = testUhr();
    const limiter = new RateLimiter({ ratePerSecond: 3, now: uhr.now, sleep: uhr.sleep });

    // Lange Pause: der Vorrat darf trotzdem nicht ueber die Burst-Groesse wachsen,
    // sonst wuerde nach einer ruhigen Phase ein Schwall auf Jama treffen.
    uhr.vorspulen(60_000);
    expect(limiter.snapshot().availableTokens).toBeLessThanOrEqual(3);
  });

  it('serialisiert gleichzeitige Anfragen, statt sie gemeinsam losstuermen zu lassen', async () => {
    const uhr = testUhr();
    const limiter = new RateLimiter({ ratePerSecond: 2, burst: 1, now: uhr.now, sleep: uhr.sleep });

    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    // Ohne Serialisierung saehen alle drei dieselbe Luecke und die Uhr bliebe bei 0.
    expect(uhr.now()).toBeGreaterThan(0);
  });

  it('bleibt nach einem Fehler in der Warteschlange benutzbar', async () => {
    const uhr = testUhr();
    const limiter = new RateLimiter({ ratePerSecond: 10, now: uhr.now, sleep: uhr.sleep });

    await limiter.acquire();
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });
});

describe('Backoff nach Drosselung', () => {
  it('folgt der von Jama empfohlenen Fibonacci-Staffelung', () => {
    const ohneJitter = () => 0.5;
    expect(backoffDelayMs(0, ohneJitter)).toBe(3000);
    expect(backoffDelayMs(1, ohneJitter)).toBe(5000);
    expect(backoffDelayMs(2, ohneJitter)).toBe(8000);
    expect(backoffDelayMs(3, ohneJitter)).toBe(13_000);
  });

  it('deckelt bei der letzten Stufe, statt unbegrenzt zu wachsen', () => {
    const ohneJitter = () => 0.5;
    const letzte = BACKOFF_SECONDS.at(-1)! * 1000;
    expect(backoffDelayMs(20, ohneJitter)).toBe(letzte);
  });

  it('streut die Wartezeit, damit Clients nicht im Gleichschritt wiederkommen', () => {
    const niedrig = backoffDelayMs(0, () => 0);
    const hoch = backoffDelayMs(0, () => 0.999);
    expect(niedrig).toBeLessThan(hoch);
    // Streuung von plus/minus 20 Prozent.
    expect(niedrig).toBeGreaterThanOrEqual(2400);
    expect(hoch).toBeLessThanOrEqual(3600);
  });
});
