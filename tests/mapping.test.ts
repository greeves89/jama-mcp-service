import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, shorten, stripTags } from '../src/jama/markdown.js';
import { estimateTokens, truncateList, truncateText } from '../src/shared/tokens.js';
import { collectItemTypeIds, itemName, toItemDetail, toItemSummary } from '../src/jama/mapping.js';
import type { MappingContext } from '../src/jama/mapping.js';
import type { JamaItem } from '../src/jama/types.js';

/**
 * Aufbereitung der Antworten.
 *
 * Diese Schicht entscheidet darueber, ob ein Item 300 oder 3.000 Token kostet
 * und ob ein Sprachmodell mit "status: 307" oder "status: Approved" arbeiten
 * muss. Beides schlaegt unmittelbar auf Nutzbarkeit und Kosten durch.
 */

function kontext(): MappingContext {
  return {
    schema: {} as MappingContext['schema'],
    optionLabels: new Map([
      [307, 'Approved'],
      [308, 'Draft'],
      [401, 'Hoch'],
    ]),
    userLabels: new Map([
      [7, 'Ada Lovelace'],
      [9, 'Alan Turing'],
    ]),
    baseUrl: 'https://beispiel.jamacloud.com',
  itemTypeLabels: new Map([
      [32, 'Requirement'],
      [33, 'Test Case'],
    ]),
  };
}

describe('HTML nach Markdown', () => {
  it('wandelt Ueberschriften und Hervorhebungen um', () => {
    const ergebnis = htmlToMarkdown('<h2>Titel</h2><p>Ein <b>wichtiger</b> Satz.</p>');
    expect(ergebnis).toContain('Titel');
    expect(ergebnis).toContain('**wichtig');
  });

  it('erhaelt Tabellen als Markdown-Tabelle', () => {
    // In Jama stecken Akzeptanzkriterien haeufig in Tabellen. Zerfaellt die
    // Struktur zu Fliesstext, geht die Zuordnung Spalte zu Wert verloren.
    const ergebnis = htmlToMarkdown(
      '<table><tr><th>Parameter</th><th>Wert</th></tr><tr><td>Druck</td><td>5 bar</td></tr></table>',
    );
    expect(ergebnis).toContain('| Parameter | Wert |');
    expect(ergebnis).toContain('| --- | --- |');
    expect(ergebnis).toContain('| Druck | 5 bar |');
  });

  it('ersetzt eingebettete Bilder durch einen Platzhalter', () => {
    // Ein data-URI kann sechsstellige Zeichenzahlen erreichen und wuerde das
    // Kontextfenster allein fuellen.
    const grossesBild = `data:image/png;base64,${'A'.repeat(50_000)}`;
    const ergebnis = htmlToMarkdown(`<p>Text</p><img src="${grossesBild}" alt="Schema">`);

    expect(ergebnis).not.toContain('AAAA');
    expect(ergebnis).toContain('Schema');
    expect(ergebnis.length).toBeLessThan(200);
  });

  it('laesst reinen Text unveraendert', () => {
    expect(htmlToMarkdown('Einfach nur Text')).toBe('Einfach nur Text');
  });

  it('kommt mit leeren Werten zurecht', () => {
    expect(htmlToMarkdown(null)).toBe('');
    expect(htmlToMarkdown(undefined)).toBe('');
    expect(htmlToMarkdown('   ')).toBe('');
  });

  it('entfernt Skripte beim Entschaerfen', () => {
    expect(stripTags('<script>alert(1)</script>Text')).toBe('Text');
  });
});

describe('Kuerzen', () => {
  it('laesst kurze Texte unberuehrt', () => {
    expect(shorten('kurz', 100)).toBe('kurz');
  });

  it('haengt beim Kuerzen einen Hinweis an', () => {
    const ergebnis = shorten('x'.repeat(500), 100);
    expect(ergebnis).toContain('gekuerzt');
    expect(ergebnis).toContain('jama_get_item');
  });

  it('macht die Kuerzung eines Textes fuer das Modell erkennbar', () => {
    // Ohne Hinweis haelt ein Sprachmodell den Rumpf fuer den vollstaendigen Inhalt.
    const ergebnis = truncateText('a'.repeat(100_000), 1000);
    expect(ergebnis.truncated).toBe(true);
    expect(ergebnis.value).toContain('Zeichen entfernt');
  });

  it('kuerzt Listen von hinten und behaelt mindestens einen Eintrag', () => {
    const eintraege = Array.from({ length: 200 }, (_, index) => ({
      id: index,
      text: 'x'.repeat(200),
    }));
    const ergebnis = truncateList(eintraege, 500);

    expect(ergebnis.truncated).toBe(true);
    expect(ergebnis.value.length).toBeGreaterThanOrEqual(1);
    // Die relevantesten Treffer stehen vorn und muessen erhalten bleiben.
    expect(ergebnis.value[0]!.id).toBe(0);
  });

  it('kuerzt nicht, wenn das Budget reicht', () => {
    const ergebnis = truncateList([{ id: 1 }], 10_000);
    expect(ergebnis.truncated).toBe(false);
    expect(ergebnis.removed).toBe(0);
  });

  it('schaetzt Token in plausibler Groessenordnung', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(360))).toBe(100);
  });
});

describe('Item-Aufbereitung', () => {
  const item: JamaItem = {
    id: 1234,
    documentKey: 'PROJ-REQ-42',
    itemType: 32,
    project: 5,
    createdBy: 7,
    modifiedBy: 9,
    modifiedDate: '2026-08-01T10:00:00.000Z',
    location: { sequence: '1.2.3', parent: { item: 900 } },
    fields: {
      name: 'Bremsdruck begrenzen',
      status: 307,
      description: '<p>Das System <b>muss</b> den Druck auf 5 bar begrenzen.</p>',
      'priority$32': 401,
      globalSortOrder: 99,
    },
  };

  it('erzeugt eine kompakte Zusammenfassung mit aufgeloesten Bezeichnern', () => {
    const summary = toItemSummary(item, kontext());
    expect(summary).toEqual({
      id: 1234,
      documentKey: 'PROJ-REQ-42',
      name: 'Bremsdruck begrenzen',
      itemType: 'Requirement',
      status: 'Approved',
      project: 5,
      modifiedDate: '2026-08-01T10:00:00.000Z',
      sequence: '1.2.3',
      // Der Verweis auf die Jama-Oberflaeche: ohne ihn stellt ein Sprachmodell
      // die Adresse selbst zusammen und raet dabei.
      url: 'https://beispiel.jamacloud.com/perspective.req#/items/1234?projectId=5',
    });
  });

  it('loest Picklist-Werte auch in Custom Fields auf', () => {
    // Ohne Aufloesung muesste ein Sprachmodell mit "priority$32: 401" arbeiten.
    const detail = toItemDetail(item, kontext());
    expect(detail.fields['priority$32']).toBe('Hoch');
  });

  it('loest Benutzer-IDs in Namen auf', () => {
    const detail = toItemDetail(item, kontext());
    expect(detail.createdBy).toBe('Ada Lovelace');
    expect(detail.modifiedBy).toBe('Alan Turing');
  });

  it('konvertiert die Beschreibung nach Markdown und zieht sie aus den Feldern heraus', () => {
    const detail = toItemDetail(item, kontext());
    expect(detail.description).toContain('**muss**');
    expect(detail.description).not.toContain('<p>');
    expect(detail.fields.description).toBeUndefined();
  });

  it('laesst Rauschfelder weg', () => {
    const detail = toItemDetail(item, kontext());
    expect(detail.fields.globalSortOrder).toBeUndefined();
  });

  it('haelt die Beschreibung im vorgegebenen Rahmen', () => {
    const gross: JamaItem = {
      ...item,
      fields: { ...item.fields, description: `<p>${'Lang. '.repeat(5000)}</p>` },
    };
    const detail = toItemDetail(gross, kontext(), { maxDescriptionChars: 500 });
    expect(detail.description!.length).toBeLessThan(700);
    expect(detail.description).toContain('gekuerzt');
  });

  it('findet den Namen auch als Custom Field mit Suffix', () => {
    expect(itemName({ id: 1, fields: { 'name$44': 'Aus Custom Field' } })).toBe('Aus Custom Field');
  });

  it('faellt auf den Document Key zurueck, wenn kein Name vorhanden ist', () => {
    expect(itemName({ id: 1, documentKey: 'PROJ-REQ-1', fields: {} })).toBe('PROJ-REQ-1');
  });

  it('sammelt die vorkommenden ItemType-IDs ohne Dubletten', () => {
    expect(
      collectItemTypeIds([
        { id: 1, itemType: 32 },
        { id: 2, itemType: 32 },
        { id: 3, itemType: 33 },
        { id: 4 },
      ]),
    ).toEqual([32, 33]);
  });
});
