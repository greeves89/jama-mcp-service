import { describe, expect, it } from 'vitest';
import { baueKeyUpdate } from '../src/service/keys.js';
import type { JamaCredentials } from '../src/jama/auth.js';

/**
 * Aendern eines bestehenden API-Keys.
 *
 * Anlass ist ein Praxisbefund: Ein Zugang war ohne das Toolset "core" angelegt
 * und damit unbrauchbar — es fehlte der Weg vom Projektnamen zur ID. Das
 * Dashboard bot nur Deaktivieren, Rotieren und Loeschen an. Wer die Toolsets
 * korrigieren wollte, musste den Key neu anlegen und in jedem angebundenen
 * Client austauschen.
 *
 * Die Regeln, die dabei zaehlen:
 *   1. Weggelassene Felder bleiben unangetastet — sonst muesste man bei jeder
 *      Korrektur Zugangsdaten erneut eintippen, die niemand mehr hat.
 *   2. "core" wird auch beim Aendern erzwungen.
 *   3. null entfernt ausdruecklich: beim Ablaufdatum wie bei eigenen
 *      Zugangsdaten.
 */

const verschluesselnAttrappe = (credentials: JamaCredentials) =>
  `verschluesselt:${credentials.type}`;

const oauth: JamaCredentials = { type: 'oauth', clientId: 'kennung', clientSecret: 'geheim' };

describe('Aendern eines API-Keys', () => {
  it('schreibt nur die uebergebenen Felder', () => {
    expect(baueKeyUpdate({ name: 'Neuer Name' }, verschluesselnAttrappe)).toEqual({
      name: 'Neuer Name',
    });
  });

  it('laesst die Zugangsdaten unberuehrt, wenn keine uebergeben wurden', () => {
    const update = baueKeyUpdate({ toolsets: ['core', 'trace'] }, verschluesselnAttrappe);

    // Genau der Fall "Toolset ergaenzen": ein Client-Secret liegt dafuer nicht vor.
    expect(update).not.toHaveProperty('jamaCredentialsEnc');
  });

  it('ergaenzt fehlendes core beim Aendern der Toolsets', () => {
    const update = baueKeyUpdate({ toolsets: ['history', 'write'] }, verschluesselnAttrappe);

    // Der ausloesende Praxisfall: ein Zugang mit history, aber ohne core.
    expect(update.toolsets).toEqual(['core', 'history', 'write']);
  });

  it('entfernt das Ablaufdatum bei null', () => {
    const update = baueKeyUpdate({ expiresAt: null }, verschluesselnAttrappe);

    expect(update).toHaveProperty('expiresAt', null);
  });

  it('setzt ein uebergebenes Ablaufdatum', () => {
    const update = baueKeyUpdate({ expiresAt: '2026-12-31' }, verschluesselnAttrappe);

    expect(update.expiresAt).toBeInstanceOf(Date);
    expect((update.expiresAt as Date).getUTCFullYear()).toBe(2026);
  });

  it('weist ein unbrauchbares Datum ab, statt still 1970 zu speichern', () => {
    // new Date("übermorgen") ergibt Invalid Date; ungeprueft landete das als
    // NULL oder als Fehler tief in der Datenbankschicht.
    expect(() => baueKeyUpdate({ expiresAt: 'übermorgen' }, verschluesselnAttrappe)).toThrow(
      /gültiges Datum/,
    );
  });

  it('entfernt eigene Zugangsdaten bei null', () => {
    const update = baueKeyUpdate({ credentials: null }, verschluesselnAttrappe);

    // Danach nutzt der Key wieder die Zugangsdaten der Verbindung.
    expect(update).toHaveProperty('jamaCredentialsEnc', null);
  });

  it('verschluesselt neue Zugangsdaten', () => {
    const update = baueKeyUpdate({ credentials: oauth }, verschluesselnAttrappe);

    expect(update.jamaCredentialsEnc).toBe('verschluesselt:oauth');
  });

  it('setzt beim Deaktivieren einen Zeitpunkt und beim Aktivieren null', () => {
    expect(baueKeyUpdate({ disabled: true }, verschluesselnAttrappe).disabledAt).toBeInstanceOf(
      Date,
    );
    expect(baueKeyUpdate({ disabled: false }, verschluesselnAttrappe)).toHaveProperty(
      'disabledAt',
      null,
    );
  });

  it('uebernimmt ein ausdrueckliches false bei "nur lesend"', () => {
    // Haette die Pruefung auf Wahrheitswert statt auf undefined getestet, liesse
    // sich ein Key nie von lesend auf schreibend umstellen.
    expect(baueKeyUpdate({ readOnly: false }, verschluesselnAttrappe)).toHaveProperty(
      'readOnly',
      false,
    );
  });

  it('uebernimmt eine geleerte Projekt-Allowlist', () => {
    // Leere Liste heisst "keine Einschraenkung mehr" und ist etwas anderes als
    // "nicht angegeben".
    expect(baueKeyUpdate({ allowedProjectIds: [] }, verschluesselnAttrappe)).toHaveProperty(
      'allowedProjectIds',
      [],
    );
  });

  it('ergibt bei leerer Aenderung keine Schreibvorgaenge', () => {
    expect(baueKeyUpdate({}, verschluesselnAttrappe)).toEqual({});
  });
});
