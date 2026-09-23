import { describe, expect, it, vi } from 'vitest';
import { getTool } from '../src/mcp/registry.js';
import type { ToolContext } from '../src/mcp/types.js';
import type { JamaUser } from '../src/jama/types.js';

/**
 * Trennung mehrerer Kunden in einer gemeinsamen Jama-Instanz.
 *
 * Ausgangslage: Mehrere Kunden binden ihre jeweils eigene KI an dieselbe
 * Instanz an, und es soll dafür nur einen einzigen technischen Jama-Zugang
 * geben. Damit ist die Projektfreigabe des API-Keys die einzige Grenze zwischen
 * den Mandanten — sie muss deshalb auch dort greifen, wo gar keine Projektdaten
 * abgefragt werden.
 *
 * Die Benutzerliste ist so ein Fall: Jama kennt keine Zuordnung von Personen zu
 * Projekten, die sich abfragen ließe. Ein beschränkter Zugang bekäme sonst die
 * vollständige Belegschaft samt E-Mail-Adressen und die Ansprechpartner aller
 * übrigen Kunden.
 */

const benutzer: JamaUser[] = [
  {
    id: 1,
    firstName: 'Erika',
    lastName: 'Musterfrau',
    username: 'e.musterfrau',
    email: 'erika@example.com',
    licenseType: 'CREATOR',
    active: true,
  },
  {
    id: 2,
    firstName: 'Max',
    lastName: 'Mustermann',
    username: 'm.mustermann',
    email: 'max@example.invalid',
    licenseType: 'STAKEHOLDER',
    active: true,
  },
];

function kontext(freigegeben: number[]): ToolContext {
  return {
    client: {
      schema: { getUsers: async () => benutzer },
    } as unknown as ToolContext['client'],
    apiKeyName: 'zugang',
    allowedProjectIds: freigegeben,
    readOnly: true,
    toolsets: ['core'],
    disabledTools: [],
    vermerkeHerkunft: false,
    tokenBudget: 15000,
    audit: vi.fn(),
  };
}

const listUsers = getTool('jama_list_users')!;

describe('Benutzerliste bei beschränktem Zugang', () => {
  it('gibt einem unbeschränkten Zugang alles', async () => {
    const ergebnis = (await listUsers.handler({ activeOnly: true, limit: 50 }, kontext([]))) as {
      data: Array<Record<string, unknown>>;
    };

    expect(ergebnis.data[0]).toHaveProperty('email', 'erika@example.com');
    expect(ergebnis.data[0]).toHaveProperty('lizenztyp');
  });

  it('lässt bei beschränktem Zugang die E-Mail-Adresse weg', async () => {
    const ergebnis = (await listUsers.handler({ activeOnly: true, limit: 50 }, kontext([42]))) as {
      data: Array<Record<string, unknown>>;
    };

    expect(ergebnis.data[0]).not.toHaveProperty('email');
    expect(ergebnis.data[0]).not.toHaveProperty('benutzername');
    expect(ergebnis.data[0]).not.toHaveProperty('lizenztyp');
  });

  it('behält Kennung und Name, damit Zuweisungen lesbar bleiben', async () => {
    // Ohne den Namen wäre "Bearbeiter: 12345" für jeden Leser wertlos.
    const ergebnis = (await listUsers.handler({ activeOnly: true, limit: 50 }, kontext([42]))) as {
      data: Array<Record<string, unknown>>;
    };

    expect(ergebnis.data[0]).toHaveProperty('id', 1);
    expect(ergebnis.data[0]).toHaveProperty('name', 'Erika Musterfrau');
  });

  it('weist die freie Suche bei beschränktem Zugang ab', async () => {
    // Mit ihr ließe sich die Instanz gezielt nach Personen durchforsten.
    await expect(
      listUsers.handler({ activeOnly: true, limit: 50, contains: 'muster' }, kontext([42])),
    ).rejects.toThrow(/beschraenkt/);
  });

  it('erlaubt die freie Suche einem unbeschränkten Zugang', async () => {
    const ergebnis = (await listUsers.handler(
      { activeOnly: true, limit: 50, contains: 'erika' },
      kontext([]),
    )) as { data: Array<Record<string, unknown>> };

    expect(ergebnis.data).toHaveLength(1);
  });

  it('weist auf die Einschränkung hin, statt sie zu verschweigen', async () => {
    const ergebnis = (await listUsers.handler({ activeOnly: true, limit: 50 }, kontext([42]))) as {
      notes?: string[];
    };

    expect(ergebnis.notes?.join(' ')).toMatch(/beschr/i);
  });
});
