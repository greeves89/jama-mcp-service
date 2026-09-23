import { describe, expect, it, vi } from 'vitest';
import { getTool } from '../src/mcp/registry.js';
import type { ToolContext } from '../src/mcp/types.js';

/**
 * Administrativer Aktivitätsstrom bei beschränktem Zugang.
 *
 * Der Schalter `adminOnly` führt auf einen instanzweiten Pfad: angelegte
 * Benutzer, geänderte Rechte, neue Projekte — über alle Mandanten hinweg. Für
 * einen Zugang, der ausdrücklich auf bestimmte Projekte beschränkt ist, wäre
 * das ein Ausbruch aus genau dieser Grenze, und zwar einer, der mehr preisgibt
 * als die Projektinhalte selbst.
 *
 * Verschärfend kommt hinzu, dass der technische Jama-Zugang in der
 * Zielumgebung Administratorrechte besitzt — Jama würde die Anfrage also
 * beantworten. Die Grenze existiert nur hier.
 */

function kontext(freigegeben: number[]): ToolContext {
  return {
    client: {
      http: {
        paginate: async () => ({ items: [], total: 0 }),
        getOptional: async () => undefined,
      },
      schema: { getUserLabels: async () => new Map() },
    } as unknown as ToolContext['client'],
    apiKeyName: 'zugang',
    allowedProjectIds: freigegeben,
    readOnly: true,
    toolsets: ['history'],
    disabledTools: [],
    vermerkeHerkunft: false,
    tokenBudget: 15000,
    audit: vi.fn(),
  };
}

const aktivitaeten = getTool('jama_get_activities')!;

describe('Administrativer Aktivitätsstrom', () => {
  it('weist einen beschränkten Zugang ab', async () => {
    await expect(
      aktivitaeten.handler({ adminOnly: true, limit: 50 }, kontext([42])),
    ).rejects.toThrow(/beschraenkt/);
  });

  it('trägt den Fehlercode PROJECT_FORBIDDEN', async () => {
    try {
      await aktivitaeten.handler({ adminOnly: true, limit: 50 }, kontext([42]));
      expect.unreachable('hätte abweisen müssen');
    } catch (fehler) {
      expect((fehler as { code: string }).code).toBe('PROJECT_FORBIDDEN');
    }
  });

  it('lässt einen unbeschränkten Zugang durch', async () => {
    // Der interne Betrieb soll die Verwaltungshistorie weiterhin auswerten können.
    await expect(
      aktivitaeten.handler({ adminOnly: true, limit: 50 }, kontext([])),
    ).resolves.toBeDefined();
  });

  it('prüft auch beim Weg über ein einzelnes Item das Projekt', async () => {
    // Hier steht nur die Item-Kennung im Aufruf, das Projekt muss erst
    // ermittelt werden — sonst wäre die Aktivitätshistorie jedes Items der
    // Instanz lesbar.
    const ctx = kontext([42]);
    (ctx.client.http as unknown as { getOptional: () => Promise<unknown> }).getOptional =
      async () => ({ id: 7, project: 99 });

    await expect(
      aktivitaeten.handler({ adminOnly: false, itemId: 7, limit: 50 }, ctx),
    ).rejects.toThrow(/nicht freigegeben/);
  });

  it('lässt ein Item aus einem freigegebenen Projekt zu', async () => {
    const ctx = kontext([42]);
    (ctx.client.http as unknown as { getOptional: () => Promise<unknown> }).getOptional =
      async () => ({ id: 7, project: 42 });

    await expect(
      aktivitaeten.handler({ adminOnly: false, itemId: 7, limit: 50 }, ctx),
    ).resolves.toBeDefined();
  });
});
