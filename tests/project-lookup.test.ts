import { describe, expect, it } from 'vitest';
import { resolveProjectId } from '../src/mcp/tools/core.js';
import type { JamaProject } from '../src/jama/types.js';

/**
 * Aufloesung eines Projektkuerzels auf die interne ID.
 *
 * Der Anlass ist ein Praxisbefund: Jama fuehrt Projektschluessel ("PRJ-1234")
 * und numerische ID parallel. Menschen und Fremdsysteme nennen fast immer den
 * Schluessel, jede API-Abfrage verlangt aber die Zahl. Ohne Bruecke bleibt ein
 * Aufrufer, der nur den Schluessel kennt, stecken — genau das ist beim ersten
 * echten Einsatz passiert.
 */

const projekte: JamaProject[] = [
  { id: 42, projectKey: 'PRJ-1234', fields: { name: 'Projekt Alpha' } },
  { id: 77, projectKey: 'PRJ-5678', fields: { name: 'Projekt Beta' } },
  { id: 91, fields: { name: 'Archiv PRJ-1234 (alt)', projectKey: 'ARCH-1' } },
];

function kontext(liste: JamaProject[] = projekte) {
  return {
    client: {
      schema: {
        getProjects: async () => liste,
      } as never,
    },
  };
}

describe('Projektkennung aufloesen', () => {
  it('findet ein Projekt ueber seinen Schluessel', async () => {
    await expect(resolveProjectId('PRJ-1234', kontext())).resolves.toBe(42);
  });

  it('ist unabhaengig von Gross- und Kleinschreibung', async () => {
    await expect(resolveProjectId('prj-1234', kontext())).resolves.toBe(42);
  });

  it('findet ein Projekt ueber seinen Namen', async () => {
    await expect(resolveProjectId('Projekt Beta', kontext())).resolves.toBe(77);
  });

  it('reicht eine bereits numerische Angabe unveraendert durch', async () => {
    // Spart den Aufruf gegen Jama, wenn ohnehin die ID vorliegt.
    await expect(resolveProjectId('42', kontext())).resolves.toBe(42);
  });

  it('bevorzugt die exakte Übereinstimmung vor einem Teiltreffer', async () => {
    // "PRJ-1234" steckt auch im Namen des Archivprojekts 91. Der exakte
    // Schluesseltreffer muss gewinnen, sonst landet man im falschen Projekt.
    await expect(resolveProjectId('PRJ-1234', kontext())).resolves.toBe(42);
  });

  it('meldet bei mehreren Teiltreffern die Kandidaten, statt zu raten', async () => {
    const mehrdeutig: JamaProject[] = [
      { id: 1, projectKey: 'AB-100', fields: { name: 'Antrieb Nord' } },
      { id: 2, projectKey: 'AB-200', fields: { name: 'Antrieb Sued' } },
    ];
    await expect(resolveProjectId('Antrieb', kontext(mehrdeutig))).rejects.toThrow(
      /mehrere Projekte/,
    );
  });

  it('erklaert bei fehlendem Treffer den naechsten Schritt', async () => {
    await expect(resolveProjectId('GIBTESNICHT', kontext())).rejects.toThrow(
      /jama_list_projects/,
    );
  });

  it('nennt als moegliche Ursache auch fehlende Berechtigungen', async () => {
    // Ein Projekt, das der hinterlegte Benutzer nicht sehen darf, ist von einem
    // nicht existierenden nicht zu unterscheiden — das muss die Meldung sagen.
    await expect(resolveProjectId('GIBTESNICHT', kontext())).rejects.toThrow(/Berechtigung/);
  });
});
