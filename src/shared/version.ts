import { readFileSync } from 'node:fs';

/**
 * Die Version dieses Dienstes, gelesen aus der package.json.
 *
 * Zuvor stand sie an zwei Stellen fest im Code beziehungsweise kam aus
 * process.env.npm_package_version. Diese Variable setzt aber nur npm selbst,
 * und im Container startet der Dienst als "node dist/server.js" — sie ist dort
 * also leer, und es griff dauerhaft der Ersatzwert "1.0.0". Der Health-Endpunkt
 * meldete damit unabhaengig vom tatsaechlichen Stand immer dieselbe Zahl, was
 * jede Kontrolle nach einem Update wertlos machte.
 *
 * Die package.json liegt im Laufzeit-Image neben dem dist-Verzeichnis, weil
 * "npm ci --omit=dev" sie ohnehin braucht.
 */
function leseVersion(): string {
  try {
    const pfad = new URL('../../package.json', import.meta.url);
    const inhalt = JSON.parse(readFileSync(pfad, 'utf8')) as { version?: string };
    return inhalt.version ?? 'unbekannt';
  } catch {
    // Ein fehlender oder unlesbarer Eintrag darf den Start nicht verhindern:
    // die Version ist eine Auskunft, keine Betriebsvoraussetzung.
    return 'unbekannt';
  }
}

export const VERSION = leseVersion();
