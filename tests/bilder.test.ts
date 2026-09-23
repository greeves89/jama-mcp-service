import { describe, expect, it, vi } from 'vitest';
import { getTool } from '../src/mcp/registry.js';
import type { ToolContext } from '../src/mcp/types.js';

/**
 * Bilder aus Jama an das Sprachmodell weiterreichen.
 *
 * Bilder stecken in Jama als Data-URI mitten in der Beschreibung oder als
 * Anhang am Item. In der Textausgabe erscheinen sie nur als Platzhalter, weil
 * ein einzelnes eingebettetes Bild als base64-Zeichenkette leicht mehrere
 * hunderttausend Zeichen erreicht — es würde das Kontextfenster füllen, ohne
 * dass das Modell etwas davon betrachten könnte.
 *
 * Deshalb gehen sie als eigene Bildblöcke hinaus. Die Größengrenzen sind dabei
 * kein Detail: Sie entscheiden darüber, ob ein Aufruf eine Sitzung unbrauchbar
 * macht.
 */

// Ein winziges, gültiges PNG (1x1 Pixel, transparent).
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function kontext(beschreibung: string, anhaenge: unknown[] = []): ToolContext {
  return {
    client: {
      http: {
        getOptional: async (pfad: string) =>
          pfad.startsWith('items/')
            ? { id: 7, project: 42, documentKey: 'PRJ-REQ-7', fields: { description: beschreibung } }
            : undefined,
        paginate: async () => ({ items: anhaenge, total: anhaenge.length }),
        rawRequest: async () => ({
          arrayBuffer: async () => Buffer.from(PNG, 'base64'),
          headers: { get: () => 'image/png' },
        }),
      },
      schema: {},
    } as unknown as ToolContext['client'],
    apiKeyName: 'zugang',
    allowedProjectIds: [],
    readOnly: true,
    toolsets: ['core'],
    disabledTools: [],
    vermerkeHerkunft: false,
    tokenBudget: 15000,
    audit: vi.fn(),
  };
}

const werkzeug = getTool('jama_get_item_images')!;
const standard = { quelle: 'alle' as const, maxBilder: 5, maxBytesJeBild: 4_000_000, itemId: 7 };

describe('Bilder aus der Beschreibung', () => {
  it('liefert ein eingebettetes Bild als Bildblock', async () => {
    const ergebnis = (await werkzeug.handler(
      standard,
      kontext(`<p>Text</p><img src="data:image/png;base64,${PNG}" alt="Schaltplan">`),
    )) as { bilder?: Array<{ data: string; mimeType: string }> };

    expect(ergebnis.bilder).toHaveLength(1);
    expect(ergebnis.bilder?.[0]?.mimeType).toBe('image/png');
    expect(ergebnis.bilder?.[0]?.data).toBe(PNG);
  });

  it('findet mehrere Bilder und behält ihre Reihenfolge', async () => {
    const html = `<img src="data:image/png;base64,${PNG}"><p>dazwischen</p><img src="data:image/gif;base64,${PNG}">`;
    const ergebnis = (await werkzeug.handler(standard, kontext(html))) as {
      bilder?: Array<{ mimeType: string }>;
      data: { bilder: Array<{ quelle: string }> };
    };

    expect(ergebnis.bilder).toHaveLength(2);
    expect(ergebnis.bilder?.[0]?.mimeType).toBe('image/png');
    expect(ergebnis.bilder?.[1]?.mimeType).toBe('image/gif');
    // Die Aufstellung im Text muss zur Reihenfolge der Blöcke passen, sonst
    // lässt sich ein betrachtetes Bild seiner Herkunft nicht zuordnen.
    expect(ergebnis.data.bilder[0]?.quelle).toContain('Bild 1');
    expect(ergebnis.data.bilder[1]?.quelle).toContain('Bild 2');
  });

  it('überspringt ein Bild über der Größengrenze', async () => {
    const gross = 'A'.repeat(200_000);
    await expect(
      werkzeug.handler(
        { ...standard, maxBytesJeBild: 50_000 },
        kontext(`<img src="data:image/png;base64,${gross}">`),
      ),
    ).rejects.toThrow(/keine Bilder/);
  });

  it('hält die Obergrenze für die Anzahl ein', async () => {
    // Jedes Bild belegt Platz im Kontextfenster des Clients.
    const viele = Array.from({ length: 8 }, () => `<img src="data:image/png;base64,${PNG}">`).join('');
    const ergebnis = (await werkzeug.handler({ ...standard, maxBilder: 3 }, kontext(viele))) as {
      bilder?: unknown[];
      notes?: string[];
    };

    expect(ergebnis.bilder).toHaveLength(3);
    expect(ergebnis.notes?.join(' ')).toMatch(/5 weitere/);
  });

  it('meldet verständlich, wenn es nichts zu holen gibt', async () => {
    await expect(werkzeug.handler(standard, kontext('<p>Nur Text</p>'))).rejects.toThrow(
      /keine Bilder gefunden/,
    );
  });

  it('ignoriert Verweise auf Dateien statt Data-URIs', async () => {
    // Solche Verweise laufen über die Anhänge, wo Größe und Typ bekannt sind.
    await expect(
      werkzeug.handler({ ...standard, quelle: 'beschreibung' }, kontext('<img src="/files/1.png">')),
    ).rejects.toThrow(/keine Bilder/);
  });
});

describe('Bilder aus Anhängen', () => {
  it('lädt angehängte Bilddateien', async () => {
    const ergebnis = (await werkzeug.handler(
      { ...standard, quelle: 'anhaenge' },
      kontext('', [{ id: 9, fileName: 'messschrieb.png' }]),
    )) as { bilder?: unknown[]; data: { bilder: Array<{ quelle: string }> } };

    expect(ergebnis.bilder).toHaveLength(1);
    expect(ergebnis.data.bilder[0]?.quelle).toContain('messschrieb.png');
  });

  it('lässt Anhänge aus, die keine Bilder sind', async () => {
    await expect(
      werkzeug.handler({ ...standard, quelle: 'anhaenge' }, kontext('', [
        { id: 9, fileName: 'lastenheft.docx' },
        { id: 10, fileName: 'tabelle.xlsx' },
      ])),
    ).rejects.toThrow(/keine Bilder/);
  });

  it('erkennt jpg als JPEG', async () => {
    const ergebnis = (await werkzeug.handler(
      { ...standard, quelle: 'anhaenge' },
      kontext('', [{ id: 9, fileName: 'foto.jpg' }]),
    )) as { bilder?: unknown[] };

    expect(ergebnis.bilder).toHaveLength(1);
  });
});
