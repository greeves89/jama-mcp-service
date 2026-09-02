import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOLSETS, ensureCore, parseToolsets } from '../src/shared/toolsets.js';

/**
 * "core" ist Voraussetzung fuer alles andere.
 *
 * Anlass ist ein Praxisbefund: Ein Zugang war mit "history", aber ohne "core"
 * angelegt. Damit fehlten jama_list_projects und jama_get_project_schema — es
 * gab also keinen Weg von einem Projektnamen zur numerischen ID, die alle
 * uebrigen Tools verlangen. Fuer den Anwender sah der Dienst aus wie kaputt:
 * Tools waren vorhanden, aber nichts liess sich damit anfangen.
 */
describe('Pflicht-Toolset core', () => {
  it('ergaenzt core, wenn es fehlt', () => {
    expect(ensureCore(['history'])).toEqual(['core', 'history']);
  });

  it('stellt core an den Anfang, damit es bei Tool-Limits nicht hinten wegfaellt', () => {
    // Manche Client-Plattformen laden nur die ersten N Tools.
    expect(ensureCore(['files', 'review'])[0]).toBe('core');
  });

  it('laesst eine Auswahl mit core unveraendert', () => {
    expect(ensureCore(['core', 'trace'])).toEqual(['core', 'trace']);
  });

  it('veraendert die Eingabe nicht', () => {
    const eingabe: ('history' | 'core')[] = ['history'];
    ensureCore(eingabe);
    expect(eingabe).toEqual(['history']);
  });

  it('ergibt bei leerer Auswahl einen nutzbaren Zugang statt eines toten', () => {
    expect(ensureCore([])).toEqual(['core']);
  });

  it('heilt auch eine Auswahl, die nur unbekannte Namen enthielt', () => {
    // parseToolsets wirft Unbekanntes weg; ohne ensureCore bliebe nichts uebrig.
    expect(ensureCore(parseToolsets(['gibtesnicht']))).toEqual(['core']);
  });

  it('enthaelt core bereits im Standard', () => {
    expect(DEFAULT_TOOLSETS).toContain('core');
  });
});
