import { describe, expect, it } from 'vitest';
import {
  ausJamaBenutzer,
  ausJamaProjekt,
  fehlendeEltern,
  verschmelzeBenutzer,
  verschmelzeProjekte,
  type BenutzerStand,
  type ProjektStand,
} from '../src/service/abgleich.js';

/**
 * Der Kern des Abgleichs zwischen Jama und dem Spiegel.
 *
 * Geprueft wird ausschliesslich die Entscheidung "neu, geaendert oder
 * verschwunden" — sie steckt in reinen Funktionen und braucht weder Datenbank
 * noch erreichbare Jama-Instanz.
 *
 * Der wichtigste Fall ist der letzte: Wer in Jama fehlt, wird stillgelegt und
 * nicht geloescht. Wuerde hier geloescht, verloere jede Rechtezuordnung ihren
 * Bezugspunkt, und im Dashboard staende eine nackte Nummer ohne Namen.
 */

function benutzer(jamaUserId: number, teil: Partial<BenutzerStand> = {}): BenutzerStand {
  return {
    jamaUserId,
    username: `benutzer${jamaUserId}`,
    email: `benutzer${jamaUserId}@example.com`,
    firstName: 'Vorname',
    lastName: `Nachname${jamaUserId}`,
    licenseType: 'CREATOR',
    aktiv: true,
    ...teil,
  };
}

function projekt(jamaProjectId: number, teil: Partial<ProjektStand> = {}): ProjektStand {
  return {
    jamaProjectId,
    projectKey: `PRJ-${jamaProjectId}`,
    name: `Projekt ${jamaProjectId}`,
    elternId: null,
    istOrdner: false,
    archiviert: false,
    ...teil,
  };
}

describe('Benutzerabgleich', () => {
  it('nimmt bei leerem Spiegel alles als neu auf', () => {
    const ergebnis = verschmelzeBenutzer([], [benutzer(1), benutzer(2)]);

    expect(ergebnis.neu.map((eintrag) => eintrag.jamaUserId)).toEqual([1, 2]);
    expect(ergebnis.geaendert).toEqual([]);
    expect(ergebnis.verschwunden).toEqual([]);
    expect(ergebnis.unveraendert).toEqual([]);
  });

  it('legt alle still, wenn Jama nichts mehr liefert', () => {
    const ergebnis = verschmelzeBenutzer([benutzer(1), benutzer(2)], []);

    expect(ergebnis.verschwunden).toEqual([1, 2]);
    expect(ergebnis.neu).toEqual([]);
    expect(ergebnis.geaendert).toEqual([]);
  });

  it('meldet nichts, wenn sich nichts geaendert hat', () => {
    const stand = [benutzer(1), benutzer(2)];
    const ergebnis = verschmelzeBenutzer(stand, [benutzer(1), benutzer(2)]);

    expect(ergebnis.neu).toEqual([]);
    expect(ergebnis.geaendert).toEqual([]);
    expect(ergebnis.verschwunden).toEqual([]);
    expect(ergebnis.unveraendert).toEqual([1, 2]);
  });

  it('erkennt einen geaenderten Namen', () => {
    const ergebnis = verschmelzeBenutzer(
      [benutzer(1, { lastName: 'Alt' })],
      [benutzer(1, { lastName: 'Neu' })],
    );

    expect(ergebnis.geaendert).toEqual([benutzer(1, { lastName: 'Neu' })]);
    expect(ergebnis.unveraendert).toEqual([]);
  });

  it('erkennt einen gewechselten Lizenztyp', () => {
    // Der Lizenztyp entscheidet in Jama ueber den API-Zugang; ein Wechsel auf
    // FLOAT erklaert spaetere Fehlschlaege und muss deshalb nachgezogen werden.
    const ergebnis = verschmelzeBenutzer(
      [benutzer(1, { licenseType: 'CREATOR' })],
      [benutzer(1, { licenseType: 'FLOAT' })],
    );

    expect(ergebnis.geaendert[0]?.licenseType).toBe('FLOAT');
  });

  it('legt still statt zu loeschen, wenn eine Person in Jama fehlt', () => {
    const ergebnis = verschmelzeBenutzer([benutzer(1), benutzer(2)], [benutzer(1)]);

    expect(ergebnis.verschwunden).toEqual([2]);
    // Die Person taucht in keiner Liste auf, aus der ein Loeschen folgen wuerde.
    expect(ergebnis.neu).toEqual([]);
    expect(ergebnis.geaendert).toEqual([]);
  });

  it('meldet einen bereits stillgelegten Abgang nicht erneut', () => {
    const ergebnis = verschmelzeBenutzer([benutzer(2, { aktiv: false })], []);

    expect(ergebnis.verschwunden).toEqual([]);
  });

  it('zieht eine in Jama vorgenommene Deaktivierung nach', () => {
    const ergebnis = verschmelzeBenutzer([benutzer(1)], [benutzer(1, { aktiv: false })]);

    expect(ergebnis.geaendert[0]?.aktiv).toBe(false);
    expect(ergebnis.verschwunden).toEqual([]);
  });

  it('weckt eine stillgelegte Person wieder auf, wenn Jama sie zurueckbringt', () => {
    const ergebnis = verschmelzeBenutzer([benutzer(1, { aktiv: false })], [benutzer(1)]);

    expect(ergebnis.geaendert[0]?.aktiv).toBe(true);
    expect(ergebnis.neu).toEqual([]);
  });

  it('nimmt eine in Jama neu angelegte Person auf', () => {
    const ergebnis = verschmelzeBenutzer([benutzer(1)], [benutzer(1), benutzer(9)]);

    expect(ergebnis.neu.map((eintrag) => eintrag.jamaUserId)).toEqual([9]);
    expect(ergebnis.unveraendert).toEqual([1]);
  });
});

describe('Projektabgleich', () => {
  it('nimmt bei leerem Spiegel alles als neu auf', () => {
    const ergebnis = verschmelzeProjekte([], [projekt(10), projekt(11)]);

    expect(ergebnis.neu.map((eintrag) => eintrag.jamaProjectId)).toEqual([10, 11]);
    expect(ergebnis.verschwunden).toEqual([]);
  });

  it('archiviert alles, wenn Jama nichts mehr liefert', () => {
    const ergebnis = verschmelzeProjekte([projekt(10), projekt(11)], []);

    expect(ergebnis.verschwunden).toEqual([10, 11]);
  });

  it('meldet nichts, wenn sich nichts geaendert hat', () => {
    const ergebnis = verschmelzeProjekte([projekt(10)], [projekt(10)]);

    expect(ergebnis.geaendert).toEqual([]);
    expect(ergebnis.unveraendert).toEqual([10]);
  });

  it('erkennt einen geaenderten Projektnamen', () => {
    const ergebnis = verschmelzeProjekte(
      [projekt(10, { name: 'Alter Name' })],
      [projekt(10, { name: 'Neuer Name' })],
    );

    expect(ergebnis.geaendert[0]?.name).toBe('Neuer Name');
  });

  it('erkennt den Wechsel des uebergeordneten Ordners', () => {
    // Die Oberflaeche baut ihren Baum aus genau dieser Kante. Bliebe der
    // Wechsel unbemerkt, setzte eine Auswahl "Ordner samt allem darunter" die
    // Rechte am falschen Zweig.
    const ergebnis = verschmelzeProjekte(
      [projekt(10, { elternId: 1 })],
      [projekt(10, { elternId: 2 })],
    );

    expect(ergebnis.geaendert[0]?.elternId).toBe(2);
  });

  it('erkennt das Anhaengen an die Wurzel', () => {
    const ergebnis = verschmelzeProjekte(
      [projekt(10, { elternId: 1 })],
      [projekt(10, { elternId: null })],
    );

    expect(ergebnis.geaendert[0]?.elternId).toBeNull();
  });

  it('archiviert ein verschwundenes Projekt, statt es zu loeschen', () => {
    const ergebnis = verschmelzeProjekte([projekt(10), projekt(11)], [projekt(10)]);

    expect(ergebnis.verschwunden).toEqual([11]);
    expect(ergebnis.neu).toEqual([]);
  });

  it('meldet ein bereits archiviertes Projekt nicht erneut', () => {
    const ergebnis = verschmelzeProjekte([projekt(11, { archiviert: true })], []);

    expect(ergebnis.verschwunden).toEqual([]);
  });

  it('hebt die Archivierung auf, wenn Jama das Projekt zurueckbringt', () => {
    const ergebnis = verschmelzeProjekte([projekt(10, { archiviert: true })], [projekt(10)]);

    expect(ergebnis.geaendert[0]?.archiviert).toBe(false);
  });

  it('erkennt den Wechsel zwischen Ordner und Projekt', () => {
    const ergebnis = verschmelzeProjekte(
      [projekt(10, { istOrdner: false })],
      [projekt(10, { istOrdner: true })],
    );

    expect(ergebnis.geaendert[0]?.istOrdner).toBe(true);
  });
});

describe('Uebersetzung der Jama-Antwort', () => {
  it('wertet ein fehlendes Aktiv-Kennzeichen als aktiv', () => {
    expect(ausJamaBenutzer({ id: 7, username: 'kennung' }).aktiv).toBe(true);
    expect(ausJamaBenutzer({ id: 7, active: false }).aktiv).toBe(false);
  });

  it('macht aus leeren Feldern nichts Gesetztes', () => {
    // Sonst meldete jeder Lauf dieselbe Person als geaendert, weil '' und null
    // unterschieden wuerden.
    const stand = ausJamaBenutzer({ id: 7, email: '   ', firstName: '' });

    expect(stand.email).toBeNull();
    expect(stand.firstName).toBeNull();
  });

  it('uebernimmt den uebergeordneten Ordner als Jama-Projektnummer', () => {
    const stand = ausJamaProjekt({
      id: 10,
      parent: 3,
      isFolder: true,
      projectKey: 'PRJ-10',
      fields: { name: 'Ordner' },
    });

    expect(stand).toEqual({
      jamaProjectId: 10,
      projectKey: 'PRJ-10',
      name: 'Ordner',
      elternId: 3,
      istOrdner: true,
      archiviert: false,
    });
  });

  it('kommt ohne uebergeordneten Ordner aus', () => {
    expect(ausJamaProjekt({ id: 10 }).elternId).toBeNull();
    expect(ausJamaProjekt({ id: 10 }).istOrdner).toBe(false);
  });
});

describe('Hinweis auf fehlende Ordner', () => {
  it('schweigt, wenn der Baum vollstaendig ist', () => {
    expect(fehlendeEltern([projekt(1), projekt(2, { elternId: 1 })])).toEqual([]);
  });

  it('meldet einen Zweig, dessen Ordner Jama nicht mitgeliefert hat', () => {
    const hinweise = fehlendeEltern([projekt(2, { elternId: 99 })]);

    expect(hinweise).toHaveLength(1);
    expect(hinweise[0]).toContain('übergeordneten Ordner');
  });
});
