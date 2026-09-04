import { describe, expect, it } from 'vitest';
import { itemUrl } from '../src/jama/mapping.js';

/**
 * Verweise auf Items in der Jama-Oberfläche.
 *
 * Anlass ist ein Praxisbefund: Ein Sprachmodell gab Links auf neu angelegte
 * Anforderungen aus, die ins Leere führten. Ursache war, dass die Tools gar
 * keine Adresse lieferten — das Modell stellte sie selbst zusammen und riet
 * dabei: mit dem Document Key statt der numerischen ID, ohne Projektangabe oder
 * in einer Form aus einer anderen Instanz. Die Links sahen brauchbar aus und
 * funktionierten nicht.
 *
 * Jama erwartet die numerische API-ID im Fragment und die Projekt-ID als
 * Parameter:
 *   https://instanz.jamacloud.com/perspective.req#/items/18874?projectId=30
 */
describe('Verweis auf ein Item', () => {
  it('baut die Adresse aus API-ID und Projekt', () => {
    expect(itemUrl('https://beispiel.jamacloud.com', 18874, 30)).toBe(
      'https://beispiel.jamacloud.com/perspective.req#/items/18874?projectId=30',
    );
  });

  it('kommt ohne Projektangabe aus', () => {
    // Jama findet das Item auch so; die Projektangabe verkürzt nur den Aufbau.
    expect(itemUrl('https://beispiel.jamacloud.com', 18874, undefined)).toBe(
      'https://beispiel.jamacloud.com/perspective.req#/items/18874',
    );
  });

  it('verträgt einen abschließenden Schrägstrich in der Basisadresse', () => {
    // Sonst entstünde ein doppelter Trenner, den manche Server mit 404 quittieren.
    expect(itemUrl('https://beispiel.jamacloud.com/', 1, 2)).toBe(
      'https://beispiel.jamacloud.com/perspective.req#/items/1?projectId=2',
    );
    expect(itemUrl('https://beispiel.jamacloud.com///', 1, 2)).not.toContain('.com//');
  });

  it('liefert nichts ohne Basisadresse', () => {
    // Ein halber Verweis wäre schlimmer als keiner: Er sieht aus, als führte er
    // irgendwohin.
    expect(itemUrl('', 1, 2)).toBeUndefined();
  });

  it('verwendet die numerische ID, nicht den Document Key', () => {
    const adresse = itemUrl('https://beispiel.jamacloud.com', 564, 42) ?? '';

    expect(adresse).toContain('/items/564');
    // Der Document Key ("PRJ-PRQ-564") gehört nicht in diese Adresse — genau
    // das war der Fehler, den das Modell gemacht hat.
    expect(adresse).not.toContain('PRQ');
  });
});
