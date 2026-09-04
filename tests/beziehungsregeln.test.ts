import { describe, expect, it } from 'vitest';
import { regelwerkeFuerProjekt, type Regelwerk } from '../src/mcp/tools/trace.js';

/**
 * Auswahl des geltenden Regelwerks für Beziehungen.
 *
 * Anlass ist ein Befund aus dem Betrieb: Die Vorprüfung meldete, eine
 * Verknüpfung sei nicht zulässig — das anschließende Anlegen gelang trotzdem.
 *
 * Ursache war, dass über sämtliche Regelwerke der Instanz geprüft wurde. Jama
 * wendet aber nur das dem Projekt zugeordnete an, und ersatzweise das als
 * Standard markierte. Der Fehler ging in beide Richtungen: „nicht zulässig",
 * obwohl das Anlegen gelingt, weil die passende Regel in einem fremden
 * Regelwerk lag; und „zulässig", obwohl Jama ablehnt, weil die gefundene Regel
 * für ein anderes Projekt gilt.
 *
 * Eine Vorprüfung, die in beide Richtungen irrt, ist schädlicher als gar keine:
 * Automatisierungen überspringen dann zulässige Verknüpfungen oder laufen in
 * vermeidbare Fehler.
 */

const standardwerk: Regelwerk & { name: string } = {
  name: 'Standard',
  standard: true,
  projekte: [],
};
const projektwerk: Regelwerk & { name: string } = {
  name: 'Werk A',
  standard: false,
  projekte: [42],
};
const fremdwerk: Regelwerk & { name: string } = {
  name: 'Werk B',
  standard: false,
  projekte: [99],
};

const alle = [standardwerk, projektwerk, fremdwerk];

describe('Geltendes Regelwerk', () => {
  it('nimmt das dem Projekt zugeordnete Regelwerk', () => {
    expect(regelwerkeFuerProjekt(alle, 42).map((w) => w.name)).toEqual(['Werk A']);
  });

  it('lässt das Standardwerk weg, wenn ein eigenes zugeordnet ist', () => {
    // Sonst gälten Regeln, die Jama an dieser Stelle gar nicht anwendet.
    expect(regelwerkeFuerProjekt(alle, 42)).not.toContain(standardwerk);
  });

  it('ignoriert das Regelwerk eines fremden Projekts', () => {
    // Der eigentliche Fehler: eine Regel aus "Werk B" hätte für Projekt 42
    // fälschlich „zulässig" ergeben.
    expect(regelwerkeFuerProjekt(alle, 42)).not.toContain(fremdwerk);
  });

  it('fällt auf das Standardwerk zurück, wenn dem Projekt keines zugeordnet ist', () => {
    expect(regelwerkeFuerProjekt(alle, 7).map((w) => w.name)).toEqual(['Standard']);
  });

  it('liefert nichts, wenn weder Zuordnung noch Standardwerk existiert', () => {
    // Der Aufrufer wertet das als „Jama schränkt nicht ein" — nicht als Verbot.
    expect(regelwerkeFuerProjekt([projektwerk, fremdwerk], 7)).toEqual([]);
  });

  it('gibt ohne Projektangabe alle Regelwerke zurück', () => {
    // Dann lautet die Frage nicht „gilt das hier?", sondern „was ist hinterlegt?".
    expect(regelwerkeFuerProjekt(alle, undefined)).toHaveLength(3);
  });

  it('berücksichtigt ein Regelwerk, das mehreren Projekten zugeordnet ist', () => {
    const geteilt = { name: 'Geteilt', standard: false, projekte: [1, 2, 3] };
    expect(regelwerkeFuerProjekt([geteilt], 2).map((w) => w.name)).toEqual(['Geteilt']);
    expect(regelwerkeFuerProjekt([geteilt], 4)).toEqual([]);
  });

  it('nimmt mehrere zugeordnete Regelwerke zusammen', () => {
    const zweites = { name: 'Werk A2', standard: false, projekte: [42] };
    expect(regelwerkeFuerProjekt([...alle, zweites], 42)).toHaveLength(2);
  });

  it('verändert die übergebene Liste nicht', () => {
    const eingabe = [...alle];
    regelwerkeFuerProjekt(eingabe, 42);
    expect(eingabe).toHaveLength(3);
  });
});
