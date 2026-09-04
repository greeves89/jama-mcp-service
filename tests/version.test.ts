import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/shared/version.js';
import { SERVER_VERSION } from '../src/mcp/server.js';

/**
 * Herkunft der Versionsangabe.
 *
 * Anlass ist ein Praxisbefund: Der Health-Endpunkt meldete nach jedem Update
 * weiter "1.0.0". Er las process.env.npm_package_version, und diese Variable
 * setzt nur npm selbst — im Container startet der Dienst aber direkt als
 * "node dist/server.js". Es griff also immer der Ersatzwert. Damit war die
 * uebliche Kontrolle nach einem Deployment ("steht dort die neue Version?")
 * wertlos, und ein nicht eingespieltes Update faellt niemandem auf.
 */
describe('Versionsangabe', () => {
  const ausPackageJson = (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;

  it('entspricht der package.json', () => {
    expect(VERSION).toBe(ausPackageJson);
  });

  it('ist nicht der alte fest verdrahtete Wert', () => {
    // Solange die echte Version darueber liegt, belegt das die Herkunft.
    expect(VERSION).not.toBe('1.0.0');
  });

  it('hat die Form einer Versionsnummer', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('meldet MCP-Clients dieselbe Version wie der Health-Endpunkt', () => {
    // Liefen beide auseinander, waere im Nachhinein nicht mehr feststellbar,
    // welcher Stand einen Tool-Aufruf beantwortet hat.
    expect(SERVER_VERSION).toBe(VERSION);
  });
});
