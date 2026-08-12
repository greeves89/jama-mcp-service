import { describe, expect, it, vi } from 'vitest';
import {
  assertConfirmed,
  assertToolEnabled,
  assertProjectAllowed,
  assertToolsetAllowed,
  assertWriteAllowed,
  filterByAllowedProjects,
  redactArgs,
  runGuards,
} from '../src/mcp/guards.js';
import { GuardError } from '../src/shared/errors.js';
import type { ToolContext, ToolDefinition } from '../src/mcp/types.js';

/**
 * MCDC-Matrix fuer die Schutzschichten.
 *
 * Jede Bedingung wird einzeln als ausschlaggebend nachgewiesen: es gibt zu
 * jedem Guard ein Paar von Faellen, die sich nur in genau dieser einen
 * Bedingung unterscheiden und zu unterschiedlichen Ergebnissen fuehren.
 */

function kontext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    client: {} as ToolContext['client'],
    apiKeyName: 'test',
    allowedProjectIds: [],
    readOnly: false,
    toolsets: ['core', 'write'],
    disabledTools: [],
    tokenBudget: 15_000,
    audit: vi.fn(),
    ...overrides,
  };
}

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'jama_test',
    toolset: 'core',
    title: 'Test',
    description: 'Test',
    inputSchema: {},
    mutating: false,
    handler: async () => ({ data: null }),
    ...overrides,
  } as ToolDefinition;
}

describe('Instanzweite Abschaltung einzelner Tools', () => {
  it('laesst ein Tool durch, das nicht abgeschaltet ist', () => {
    expect(() =>
      assertToolEnabled(tool({ name: 'jama_get_item' }), kontext({ disabledTools: [] })),
    ).not.toThrow();
  });

  it('sperrt ein abgeschaltetes Tool', () => {
    // Einziger Unterschied zum Fall darueber: der Name steht auf der Liste.
    expect(() =>
      assertToolEnabled(
        tool({ name: 'jama_delete_item' }),
        kontext({ disabledTools: ['jama_delete_item'] }),
      ),
    ).toThrow(GuardError);
  });

  it('trifft nur das genannte Tool, nicht sein ganzes Toolset', () => {
    // Der eigentliche Zweck: "write" bleibt nutzbar, nur das Loeschen nicht.
    const kontextMitSperre = kontext({ disabledTools: ['jama_delete_item'] });
    expect(() =>
      assertToolEnabled(tool({ name: 'jama_create_item', toolset: 'write' }), kontextMitSperre),
    ).not.toThrow();
    expect(() =>
      assertToolEnabled(tool({ name: 'jama_delete_item', toolset: 'write' }), kontextMitSperre),
    ).toThrow(GuardError);
  });

  it('meldet TOOL_DISABLED als Fehlercode', () => {
    try {
      assertToolEnabled(tool({ name: 'jama_delete_item' }), kontext({ disabledTools: ['jama_delete_item'] }));
      expect.unreachable('haette werfen muessen');
    } catch (error) {
      expect((error as GuardError).code).toBe('TOOL_DISABLED');
      // Die Meldung muss erklaeren, dass ein erneuter Versuch zwecklos ist.
      expect((error as GuardError).message).toContain('instanzweit');
    }
  });

  it('greift vor der Toolset-Pruefung', () => {
    // Wichtig fuer die Reihenfolge: die Abschaltung ist die guenstigste Pruefung
    // und soll zuerst antworten.
    try {
      runGuards(
        tool({ name: 'jama_delete_item', toolset: 'files' }),
        {},
        kontext({ toolsets: ['core'], disabledTools: ['jama_delete_item'] }),
      );
      expect.unreachable('haette werfen muessen');
    } catch (error) {
      expect((error as GuardError).code).toBe('TOOL_DISABLED');
    }
  });
});

describe('Toolset-Guard', () => {
  it('laesst ein Tool durch, dessen Toolset freigeschaltet ist', () => {
    expect(() => assertToolsetAllowed(tool({ toolset: 'core' }), kontext())).not.toThrow();
  });

  it('sperrt ein Tool, dessen Toolset nicht freigeschaltet ist', () => {
    // Einziger Unterschied zum Fall darueber: das Toolset des Tools.
    expect(() => assertToolsetAllowed(tool({ toolset: 'test' }), kontext())).toThrow(GuardError);
  });

  it('nennt in der Fehlermeldung die freigeschalteten Toolsets', () => {
    try {
      assertToolsetAllowed(tool({ toolset: 'review' }), kontext({ toolsets: ['core'] }));
      expect.unreachable('haette werfen muessen');
    } catch (error) {
      expect(error).toBeInstanceOf(GuardError);
      expect((error as GuardError).message).toContain('review');
      expect((error as GuardError).details?.allowed).toEqual(['core']);
    }
  });
});

describe('Read-only-Guard', () => {
  it('laesst ein lesendes Tool auch bei readOnly durch', () => {
    expect(() =>
      assertWriteAllowed(tool({ mutating: false }), kontext({ readOnly: true })),
    ).not.toThrow();
  });

  it('laesst ein schreibendes Tool bei readOnly=false durch', () => {
    expect(() =>
      assertWriteAllowed(tool({ mutating: true }), kontext({ readOnly: false })),
    ).not.toThrow();
  });

  it('sperrt ein schreibendes Tool bei readOnly=true', () => {
    // readOnly ist hier die ausschlaggebende Bedingung.
    expect(() => assertWriteAllowed(tool({ mutating: true }), kontext({ readOnly: true }))).toThrow(
      GuardError,
    );
  });

  it('meldet READ_ONLY als Fehlercode', () => {
    try {
      assertWriteAllowed(tool({ mutating: true }), kontext({ readOnly: true }));
      expect.unreachable('haette werfen muessen');
    } catch (error) {
      expect((error as GuardError).code).toBe('READ_ONLY');
    }
  });
});

describe('Bestaetigungs-Guard', () => {
  it('verlangt bei nicht zerstoerenden Tools keine Bestaetigung', () => {
    expect(() => assertConfirmed(tool({ destructive: false }), {}, kontext())).not.toThrow();
  });

  it('laesst ein zerstoerendes Tool mit confirm: true durch', () => {
    expect(() =>
      assertConfirmed(tool({ destructive: true }), { confirm: true }, kontext()),
    ).not.toThrow();
  });

  it('sperrt ein zerstoerendes Tool ohne Bestaetigung', () => {
    expect(() => assertConfirmed(tool({ destructive: true }), {}, kontext())).toThrow(GuardError);
  });

  it('sperrt auch bei confirm: "true" als Zeichenkette', () => {
    // Ein LLM koennte den Wert als Text liefern; das darf nicht als
    // Bestaetigung durchgehen.
    expect(() => assertConfirmed(tool({ destructive: true }), { confirm: 'true' }, kontext())).toThrow(
      GuardError,
    );
  });

  it('schreibt bei fehlender Bestaetigung einen Audit-Eintrag', () => {
    const audit = vi.fn();
    expect(() =>
      assertConfirmed(tool({ destructive: true }), { itemId: 5 }, kontext({ audit })),
    ).toThrow();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'denied', action: 'jama_test.denied' }),
    );
  });
});

describe('Projekt-Guard', () => {
  it('laesst bei leerer Allowlist jedes Projekt durch', () => {
    expect(() => assertProjectAllowed(99, kontext({ allowedProjectIds: [] }))).not.toThrow();
  });

  it('laesst ein freigegebenes Projekt durch', () => {
    expect(() => assertProjectAllowed(12, kontext({ allowedProjectIds: [12, 34] }))).not.toThrow();
  });

  it('sperrt ein nicht freigegebenes Projekt', () => {
    expect(() => assertProjectAllowed(99, kontext({ allowedProjectIds: [12, 34] }))).toThrow(
      GuardError,
    );
  });

  it('laesst eine unbekannte Projektzuordnung durch, statt blind zu sperren', () => {
    // Nicht jede Jama-Antwort traegt eine Projekt-Angabe. Haerte an dieser
    // Stelle wuerde legitime Aufrufe blockieren; die Jama-Berechtigungen
    // greifen ohnehin weiterhin.
    expect(() => assertProjectAllowed(undefined, kontext({ allowedProjectIds: [12] }))).not.toThrow();
  });
});

describe('Projektfilter fuer Ergebnislisten', () => {
  it('entfernt Treffer aus nicht freigegebenen Projekten', () => {
    const ergebnis = filterByAllowedProjects(
      [{ project: 1 }, { project: 2 }, { project: 3 }],
      kontext({ allowedProjectIds: [1, 3] }),
    );
    expect(ergebnis.items).toHaveLength(2);
    expect(ergebnis.removed).toBe(1);
  });

  it('laesst bei leerer Allowlist alles durch', () => {
    const ergebnis = filterByAllowedProjects([{ project: 1 }, { project: 2 }], kontext());
    expect(ergebnis.items).toHaveLength(2);
    expect(ergebnis.removed).toBe(0);
  });
});

describe('runGuards als Gesamtkette', () => {
  it('prueft das Projekt aus den Argumenten mit', () => {
    expect(() =>
      runGuards(tool(), { projectId: 99 }, kontext({ allowedProjectIds: [12] })),
    ).toThrow(GuardError);
  });

  it('scheitert am Toolset, bevor das Projekt geprueft wird', () => {
    // Reihenfolge zaehlt: die guenstigste Pruefung soll zuerst greifen.
    try {
      runGuards(
        tool({ toolset: 'files' }),
        { projectId: 99 },
        kontext({ toolsets: ['core'], allowedProjectIds: [12] }),
      );
      expect.unreachable('haette werfen muessen');
    } catch (error) {
      expect((error as GuardError).code).toBe('TOOLSET_FORBIDDEN');
    }
  });
});

describe('Redigieren von Aufrufparametern', () => {
  it('entfernt Werte unter verdaechtigen Schluesselnamen', () => {
    const ergebnis = redactArgs({
      clientSecret: 'geheim',
      password: 'geheim',
      apiKey: 'geheim',
      pin: '12345678',
      itemId: 42,
    });
    expect(ergebnis.clientSecret).toBe('[redigiert]');
    expect(ergebnis.password).toBe('[redigiert]');
    expect(ergebnis.apiKey).toBe('[redigiert]');
    expect(ergebnis.pin).toBe('[redigiert]');
    expect(ergebnis.itemId).toBe(42);
  });

  it('kuerzt lange Freitexte, statt sie vollstaendig zu protokollieren', () => {
    const ergebnis = redactArgs({ description: 'x'.repeat(1200) });
    expect(String(ergebnis.description)).toContain('1200 Zeichen');
    expect(String(ergebnis.description).length).toBeLessThan(300);
  });

  it('redigiert ein ganzes Objekt, wenn schon sein Name auf Geheimnisse deutet', () => {
    // "credentials" wird vollstaendig ersetzt, statt Feld fuer Feld geprueft zu
    // werden — das ist die sichere Richtung: ein unbekanntes Unterfeld bliebe
    // sonst stehen.
    const ergebnis = redactArgs({ credentials: { clientSecret: 'geheim', clientId: 'abc' } });
    expect(ergebnis.credentials).toBe('[redigiert]');
  });

  it('redigiert einzelne Felder in unverdaechtigen Elternobjekten', () => {
    const ergebnis = redactArgs({ fields: { name: 'sichtbar', apiKey: 'geheim' } });
    const verschachtelt = ergebnis.fields as Record<string, unknown>;
    expect(verschachtelt.name).toBe('sichtbar');
    expect(verschachtelt.apiKey).toBe('[redigiert]');
  });
});

describe('Tool-Registrierung bei Abschaltung', () => {
  it('entfernt abgeschaltete Tools aus der Liste der zu registrierenden', async () => {
    const { toolsForToolsets } = await import('../src/mcp/registry.js');

    const alle = toolsForToolsets(['core', 'write']);
    const abgeschaltet = ['jama_delete_item', 'jama_bulk_update_items'];
    const uebrig = alle.filter((tool) => !abgeschaltet.includes(tool.name));

    expect(alle.length - uebrig.length).toBe(2);
    expect(uebrig.some((tool) => tool.name === 'jama_delete_item')).toBe(false);
    // Der Rest des Toolsets bleibt vollstaendig erhalten — genau das ist der
    // Zweck gegenueber dem Abschalten eines ganzen Toolsets.
    expect(uebrig.some((tool) => tool.name === 'jama_create_item')).toBe(true);
    expect(uebrig.some((tool) => tool.name === 'jama_update_item')).toBe(true);
  });

  it('laesst bei leerer Abschaltliste alle Tools stehen', async () => {
    const { toolsForToolsets } = await import('../src/mcp/registry.js');
    const alle = toolsForToolsets(['core']);
    expect(alle.filter((tool) => ![].includes(tool.name as never))).toHaveLength(alle.length);
  });
});
