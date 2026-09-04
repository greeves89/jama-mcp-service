import { describe, expect, it } from 'vitest';
import { SchemaResolver } from '../src/jama/schema.js';
import type { JamaItemType } from '../src/jama/types.js';

/**
 * Auflösung eines ItemTypes aus Schlüssel, Anzeigename oder ID.
 *
 * Anlass ist ein Praxisbefund: Beim Anlegen eines Sets verlangt Jama zwingend
 * den Typ der enthaltenen Items ("Sets and Folders must always have a child
 * type specified"). Aufrufer kennen dafür fast nie die numerische ID — in der
 * Oberfläche steht der Anzeigename, in Document Keys der Schlüssel.
 *
 * Erschwerend führen Instanzen abgelöste Typen parallel zu ihren Nachfolgern
 * weiter, teils mit ähnlichem Namen. Die IDs unterscheiden sich zwischen
 * Instanzen; im Code darf deshalb keine Zuordnung fest hinterlegt sein.
 */

// Nachbildung einer realen Instanz — samt eines abgelösten Typs mit fast
// gleichem Namen, wie er in gewachsenen Installationen vorkommt.
const typen: JamaItemType[] = [
  { id: 32, typeKey: 'FLD', display: 'Folder', displayPlural: 'Folders' },
  { id: 31, typeKey: 'SET', display: 'Set', displayPlural: 'Sets' },
  { id: 146, typeKey: 'RS', display: 'Requirement Specification Item' },
  { id: 133, typeKey: 'PRQ', display: '[old] Requirement Specification Item' },
  { id: 150, typeKey: 'RQ', display: 'Requirement', displayPlural: 'Requirements' },
];

function schema(): SchemaResolver {
  const instanz = Object.create(SchemaResolver.prototype) as SchemaResolver;
  Object.defineProperty(instanz, 'getItemTypes', {
    value: async () => typen,
  });
  return instanz;
}

describe('ItemType finden', () => {
  it('findet über den Typschlüssel', async () => {
    expect((await schema().findItemType('RS'))?.id).toBe(146);
  });

  it('findet über den Anzeigenamen', async () => {
    expect((await schema().findItemType('Requirement Specification Item'))?.id).toBe(146);
  });

  it('unterscheidet den abgelösten Typ vom aktuellen', async () => {
    // Beide heißen fast gleich; nur der Schlüssel trennt sie zuverlässig.
    expect((await schema().findItemType('PRQ'))?.id).toBe(133);
    expect((await schema().findItemType('RS'))?.id).toBe(146);
  });

  it('nimmt eine numerische ID unverändert', async () => {
    expect((await schema().findItemType(146))?.typeKey).toBe('RS');
  });

  it('versteht eine ID auch in Textform', async () => {
    // Sprachmodelle liefern Zahlen häufig als Zeichenkette.
    expect((await schema().findItemType('146'))?.typeKey).toBe('RS');
  });

  it('ignoriert Groß- und Kleinschreibung sowie Leerzeichen', async () => {
    expect((await schema().findItemType('  rs  '))?.id).toBe(146);
    expect((await schema().findItemType('requirement specification item'))?.id).toBe(146);
  });

  it('findet auch über die Mehrzahlform', async () => {
    expect((await schema().findItemType('Requirements'))?.id).toBe(150);
  });

  it('liefert nichts bei einem unbekannten Namen', async () => {
    expect(await schema().findItemType('Gibtesnicht')).toBeUndefined();
  });

  it('liefert nichts bei leerer Eingabe', async () => {
    expect(await schema().findItemType('   ')).toBeUndefined();
  });

  it('bevorzugt den Schlüssel vor dem Anzeigenamen', async () => {
    // Wäre es umgekehrt, träfe eine Suche nach "Set" womöglich einen Typ,
    // der bloß "Set" im Anzeigenamen trägt.
    expect((await schema().findItemType('SET'))?.id).toBe(31);
  });
});
