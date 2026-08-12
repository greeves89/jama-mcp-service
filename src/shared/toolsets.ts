/**
 * Toolsets sind die Einheit, in der Faehigkeiten pro API-Key freigeschaltet
 * werden. Sie loesen gleich zwei Probleme: sie begrenzen den Schaden eines
 * kompromittierten Keys, und sie halten die Tool-Liste im Kontextfenster des
 * LLM klein — bei ueber 45 Tools verschlechtert sich sonst die Trefferquote
 * der Tool-Auswahl spuerbar.
 */

export const TOOLSETS = [
  'core',
  'trace',
  'write',
  'collab',
  'test',
  'history',
  'review',
  'files',
] as const;

export type Toolset = (typeof TOOLSETS)[number];

export interface ToolsetInfo {
  id: Toolset;
  label: string;
  description: string;
  /** Enthaelt das Toolset Tools, die Daten in Jama veraendern? */
  mutating: boolean;
  /** Nutzt das Toolset "labs"-Endpoints ohne Support-Zusage von Jama? */
  labs: boolean;
}

export const TOOLSET_INFO: Record<Toolset, ToolsetInfo> = {
  core: {
    id: 'core',
    label: 'Kern',
    description:
      'Projekte, Schema-Discovery, Suche, Item-Details, Baumnavigation, gespeicherte Filter, Releases, Tags, Benutzer.',
    mutating: false,
    labs: false,
  },
  trace: {
    id: 'trace',
    label: 'Traceability',
    description:
      'Beziehungen lesen, Traceability-Ketten verfolgen, Abdeckungsluecken finden, Relationship-Rules pruefen.',
    mutating: false,
    labs: false,
  },
  write: {
    id: 'write',
    label: 'Schreiben',
    description:
      'Items anlegen, aendern, verschieben, duplizieren und loeschen; Beziehungen und Tags pflegen; Sperren setzen.',
    mutating: true,
    labs: false,
  },
  collab: {
    id: 'collab',
    label: 'Zusammenarbeit',
    description: 'Kommentare lesen und schreiben, Workflow-Uebergaenge ausfuehren.',
    mutating: true,
    labs: false,
  },
  test: {
    id: 'test',
    label: 'Test-Management',
    description:
      'Testplaene, Testzyklen und Testlaeufe lesen und pflegen, Zyklus-Auswertungen erzeugen.',
    mutating: true,
    labs: false,
  },
  history: {
    id: 'history',
    label: 'Historie',
    description:
      'Baselines verwalten und vergleichen, Versionshistorie und Aktivitaeten lesen, geloeschte Items wiederherstellen.',
    mutating: true,
    labs: false,
  },
  review: {
    id: 'review',
    label: 'Reviews',
    description:
      'Reviews, Fortschritt und Review-Kommentare lesen. Nutzt labs-Endpoints (ab Jama Connect 9.32).',
    mutating: false,
    labs: true,
  },
  files: {
    id: 'files',
    label: 'Dateien und Reports',
    description:
      'Anhaenge auflisten, hochladen und herunterladen; Jama-Reports auflisten und starten.',
    mutating: true,
    labs: true,
  },
};

/** Sinnvoller Standard beim Anlegen eines neuen Keys: lesend, ohne labs. */
export const DEFAULT_TOOLSETS: Toolset[] = ['core', 'trace'];

export function isToolset(value: string): value is Toolset {
  return (TOOLSETS as readonly string[]).includes(value);
}

export function parseToolsets(values: readonly string[]): Toolset[] {
  return values.filter(isToolset);
}

/** Toolsets, die schreibende Tools enthalten — fuer Warnhinweise im Admin. */
export function mutatingToolsets(values: readonly Toolset[]): Toolset[] {
  return values.filter((id) => TOOLSET_INFO[id].mutating);
}
