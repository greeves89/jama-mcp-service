import { describe, expect, it, vi } from 'vitest';
import { assertProjectAllowed } from '../src/mcp/guards.js';
import type { ToolContext } from '../src/mcp/types.js';

/**
 * Projektgrenzen eines beschränkten Zugangs.
 *
 * Hintergrund: In der Zielumgebung binden mehrere Kunden ihre jeweils eigene KI
 * an dieselbe Jama-Instanz an. Ein Zugang, der für die Projekte eines Kunden
 * freigegeben ist, darf weder Inhalte noch Metadaten anderer Kunden erreichen —
 * auch nicht über Umwege.
 *
 * Der Umweg ist hier das Entscheidende: Mehrere Werkzeuge sprechen Objekte über
 * ihre eigene ID an (Anhang, Beziehung, Review, Aktivität) statt über ein Item.
 * Bei ihnen fehlte die Prüfung, weil kein Projekt im Aufruf steht — es musste
 * erst über das zugehörige Objekt ermittelt werden.
 */

function kontext(freigegeben: number[]): ToolContext {
  return {
    client: {} as ToolContext['client'],
    apiKeyName: 'kundenzugang',
    allowedProjectIds: freigegeben,
    readOnly: false,
    toolsets: ['core'],
    disabledTools: [],
    vermerkeHerkunft: false,
    tokenBudget: 15000,
    audit: vi.fn(),
  };
}

describe('Projektfreigabe', () => {
  it('lässt ein freigegebenes Projekt durch', () => {
    expect(() => assertProjectAllowed(42, kontext([42, 43]))).not.toThrow();
  });

  it('weist ein fremdes Projekt ab', () => {
    expect(() => assertProjectAllowed(99, kontext([42]))).toThrow(/nicht freigegeben/);
  });

  it('nennt im Fehlertext die freigegebenen Projekte', () => {
    // Damit der Aufrufer weiß, womit er arbeiten darf, statt zu raten.
    expect(() => assertProjectAllowed(99, kontext([42, 43]))).toThrow(/42, 43/);
  });

  it('lässt ohne Allowlist alles durch', () => {
    // Eine leere Liste heißt "keine zusätzliche Einschränkung über die
    // Jama-Rechte hinaus" — nicht "nichts erlaubt".
    expect(() => assertProjectAllowed(99, kontext([]))).not.toThrow();
  });

  it('lässt einen unbekannten Projektbezug durch', () => {
    // Bewusst so: Die Prüfung kann nur greifen, wo ein Projekt bekannt ist.
    // Genau deshalb müssen die Werkzeuge es vorher ermitteln — siehe unten.
    expect(() => assertProjectAllowed(undefined, kontext([42]))).not.toThrow();
  });

  it('trägt den Fehlercode PROJECT_FORBIDDEN', () => {
    // Maschinenlesbar, damit ein Client den Fall von einem Rechtefehler in Jama
    // unterscheiden kann.
    try {
      assertProjectAllowed(99, kontext([42]));
      expect.unreachable('hätte abweisen müssen');
    } catch (fehler) {
      expect((fehler as { code: string }).code).toBe('PROJECT_FORBIDDEN');
    }
  });
});
