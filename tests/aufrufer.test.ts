import { describe, expect, it } from 'vitest';
import { aufruferAusAnfrage, aufruferText } from '../src/mcp/aufrufer.js';
import type { FastifyRequest } from 'fastify';

/**
 * Ermittlung der Person, die einen Aufruf ausgelöst hat.
 *
 * Der API-Key benennt nur den Zugang. Teilen sich mehrere Menschen einen Zugang
 * — der Regelfall bei einem Chat-Werkzeug —, ist ohne diese Angabe nicht mehr
 * feststellbar, wer eine Änderung in Jama veranlasst hat.
 *
 * Open WebUI sendet die Kopfzeilen, sobald ENABLE_FORWARD_USER_INFO_HEADERS
 * gesetzt ist, reicht sie bislang aber nur an OpenAI-kompatible Endpunkte
 * weiter, noch nicht an MCP-Server (open-webui Nr. 21184). Die Auswertung muss
 * deshalb auch ohne diese Angaben sauber weiterlaufen.
 */

function anfrage(headers: Record<string, string | string[]>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('Aufrufer aus den Kopfzeilen', () => {
  it('liest Name, Email und Kennung von Open WebUI', () => {
    const aufrufer = aufruferAusAnfrage(
      anfrage({
        'x-openwebui-user-name': 'Erika Musterfrau',
        'x-openwebui-user-email': 'erika@example.com',
        'x-openwebui-user-id': 'u-42',
      }),
    );

    expect(aufrufer).toEqual({
      name: 'Erika Musterfrau',
      email: 'erika@example.com',
      id: 'u-42',
    });
  });

  it('versteht auch die Kopfzeilen anderer Clients und Proxys', () => {
    expect(aufruferAusAnfrage(anfrage({ 'x-forwarded-user': 'erika' }))?.name).toBe('erika');
    expect(aufruferAusAnfrage(anfrage({ 'x-remote-user': 'erika' }))?.name).toBe('erika');
  });

  it('liefert nichts, wenn keine Kopfzeile gesetzt ist', () => {
    // Der heutige Regelfall bei Open WebUI über MCP — muss geräuschlos gehen.
    expect(aufruferAusAnfrage(anfrage({}))).toBeUndefined();
  });

  it('ignoriert eine leere Kopfzeile', () => {
    expect(aufruferAusAnfrage(anfrage({ 'x-openwebui-user-name': '   ' }))).toBeUndefined();
  });

  it('entfernt Steuerzeichen', () => {
    // Sonst ließe sich über eine Kopfzeile eine Logzeile fälschen oder ein
    // Jama-Kommentar mit untergeschobenem Text erzeugen.
    const aufrufer = aufruferAusAnfrage(
      anfrage({ 'x-openwebui-user-name': 'Erika\nADMIN\r\nGefaelscht' }),
    );

    expect(aufrufer?.name).not.toContain('\n');
    expect(aufrufer?.name).not.toContain('\r');
  });

  it('begrenzt die Länge', () => {
    const aufrufer = aufruferAusAnfrage(anfrage({ 'x-openwebui-user-name': 'A'.repeat(500) }));

    expect(aufrufer?.name?.length).toBeLessThanOrEqual(120);
  });

  it('nimmt bei mehrfach gesetzter Kopfzeile den ersten Wert', () => {
    const aufrufer = aufruferAusAnfrage(
      anfrage({ 'x-openwebui-user-name': ['Erika', 'Untergeschoben'] }),
    );

    expect(aufrufer?.name).toBe('Erika');
  });
});

describe('Bezeichnung für Protokoll und Kommentar', () => {
  it('nennt Name und Email zusammen', () => {
    expect(aufruferText({ name: 'Erika Musterfrau', email: 'erika@example.com' })).toBe(
      'Erika Musterfrau <erika@example.com>',
    );
  });

  it('kommt mit nur einem der beiden aus', () => {
    expect(aufruferText({ name: 'Erika Musterfrau' })).toBe('Erika Musterfrau');
    expect(aufruferText({ email: 'erika@example.com' })).toBe('erika@example.com');
  });

  it('sagt ausdrücklich, wenn nichts übermittelt wurde', () => {
    // Wichtiger als es aussieht: Ein erfundener Name im Jama-Kommentar wäre
    // schlimmer als die ehrliche Auskunft, dass niemand benannt wurde.
    expect(aufruferText(undefined)).toBe('nicht uebermittelt');
    expect(aufruferText({})).toBe('nicht uebermittelt');
  });
});
