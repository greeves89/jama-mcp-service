import { describe, expect, it } from 'vitest';
import {
  baueVerbindungsUpdate,
  testergebnisWirdUngueltig,
} from '../src/service/connections.js';
import type { JamaCredentials } from '../src/jama/auth.js';

/**
 * Aendern einer bestehenden Jama-Verbindung.
 *
 * Anlass ist ein Praxisbefund: Eine hinterlegte Anmeldung lief ab, Jama
 * antwortete mit 401. Das Dashboard bot dafuer nur Loeschen an — und das
 * scheitert, sobald API-Keys an der Verbindung haengen. Der Zugang war damit
 * dauerhaft kaputt, ohne Weg zurueck.
 *
 * Die beiden Regeln, die dabei zaehlen:
 *   1. Weggelassene Felder bleiben unangetastet. Nur so laesst sich der Name
 *      korrigieren, ohne ein Client-Secret erneut einzutippen, das Jama nur ein
 *      einziges Mal anzeigt.
 *   2. Ein frueheres Testergebnis wird verworfen, sobald sich Ziel oder
 *      Zugangsdaten aendern.
 */

const verschluesselnAttrappe = (credentials: JamaCredentials) =>
  `verschluesselt:${credentials.type}`;

const oauth: JamaCredentials = {
  type: 'oauth',
  clientId: 'kennung',
  clientSecret: 'geheim',
};

describe('Aendern einer Verbindung', () => {
  it('schreibt nur die uebergebenen Felder', () => {
    const update = baueVerbindungsUpdate({ name: 'Sandbox' }, verschluesselnAttrappe);

    expect(update).toEqual({ name: 'Sandbox' });
  });

  it('laesst die Zugangsdaten unberuehrt, wenn keine uebergeben wurden', () => {
    const update = baueVerbindungsUpdate(
      { name: 'Neuer Name', rateLimitRps: 4 },
      verschluesselnAttrappe,
    );

    // Genau das ist der Fall "nur den Namen korrigieren": Ein Secret, das Jama
    // nur einmal anzeigt, muss dafuer nicht erneut vorliegen.
    expect(update).not.toHaveProperty('credentialsEnc');
    expect(update).not.toHaveProperty('authType');
  });

  it('verschluesselt neue Zugangsdaten und fuehrt die Anmeldeart nach', () => {
    const update = baueVerbindungsUpdate({ credentials: oauth }, verschluesselnAttrappe);

    expect(update.credentialsEnc).toBe('verschluesselt:oauth');
    expect(update.authType).toBe('oauth');
  });

  it('entfernt einen abschliessenden Schraegstrich aus der Adresse', () => {
    const update = baueVerbindungsUpdate(
      { baseUrl: 'https://beispiel.example///' },
      verschluesselnAttrappe,
    );

    // Doppelte Trenner beim Zusammensetzen der Pfade beantworten manche Server
    // mit 404.
    expect(update.baseUrl).toBe('https://beispiel.example');
  });

  it('uebernimmt ein ausdrueckliches null beim Anfragelimit', () => {
    const update = baueVerbindungsUpdate({ rateLimitRps: null }, verschluesselnAttrappe);

    // null heisst "Standard verwenden" und ist etwas anderes als "nicht angegeben".
    expect(update).toHaveProperty('rateLimitRps', null);
  });

  it('uebernimmt ein ausdrueckliches false beim Produktivkennzeichen', () => {
    const update = baueVerbindungsUpdate({ isProduction: false }, verschluesselnAttrappe);

    // Haette die Pruefung auf Wahrheitswert statt auf undefined getestet, liesse
    // sich die Markierung nie wieder entfernen.
    expect(update).toHaveProperty('isProduction', false);
  });

  it('ergibt bei leerer Aenderung keine Schreibvorgaenge', () => {
    expect(baueVerbindungsUpdate({}, verschluesselnAttrappe)).toEqual({});
  });
});

describe('Gueltigkeit des letzten Testergebnisses', () => {
  it('verfaellt bei geaenderter Adresse', () => {
    expect(testergebnisWirdUngueltig({ baseUrl: 'https://andere.example' })).toBe(true);
  });

  it('verfaellt bei geaenderten Zugangsdaten', () => {
    expect(testergebnisWirdUngueltig({ credentials: oauth })).toBe(true);
  });

  it('bleibt bestehen bei Name, Produktivkennzeichen und Anfragelimit', () => {
    // Diese drei beruehren die Erreichbarkeit nicht.
    expect(
      testergebnisWirdUngueltig({ name: 'Anderer Name', isProduction: true, rateLimitRps: 3 }),
    ).toBe(false);
  });

  it('setzt den Zustand samt Begruendung und Pruefzeitpunkt zurueck', () => {
    const update = baueVerbindungsUpdate(
      { baseUrl: 'https://andere.example' },
      verschluesselnAttrappe,
    );

    expect(update.healthStatus).toBe('unknown');
    expect(update.healthMessage).toBeTypeOf('string');
    // Ohne das Zuruecksetzen stuende in der Uebersicht weiter ein Pruefdatum,
    // das sich auf die alte Adresse bezieht.
    expect(update).toHaveProperty('lastHealthCheckAt', null);
  });

  it('ruehrt den Zustand nicht an, wenn nur der Name wechselt', () => {
    const update = baueVerbindungsUpdate({ name: 'Sandbox' }, verschluesselnAttrappe);

    expect(update).not.toHaveProperty('healthStatus');
    expect(update).not.toHaveProperty('lastHealthCheckAt');
  });
});
