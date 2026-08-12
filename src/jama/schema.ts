import { CACHE_TTL_MS, cacheKey, jamaCache } from './cache.js';
import type { JamaHttp } from './http.js';
import type {
  JamaItemType,
  JamaPickList,
  JamaPickListOption,
  JamaProject,
  JamaRelationshipType,
  JamaUser,
} from './types.js';

/**
 * Schema-Aufloesung.
 *
 * Ohne diese Schicht muesste das LLM raten: Jama liefert Picklist-Felder als
 * blanke Zahlen ("status": 307) und Custom Fields unter dynamischen Namen mit
 * ItemType-Suffix ("priority$32"). Beides ist fuer ein Sprachmodell nicht
 * interpretierbar und beim Schreiben nicht erratbar.
 *
 * Alle Aufrufe hier laufen ueber den Cache — Stammdaten aendern sich selten,
 * werden aber bei praktisch jedem Tool-Aufruf gebraucht.
 */

export class SchemaResolver {
  constructor(
    private readonly http: JamaHttp,
    private readonly connectionId: string,
  ) {}

  private async cached<T>(parts: (string | number)[], ttl: number, load: () => Promise<T>): Promise<T> {
    const key = cacheKey(this.connectionId, ...parts);
    const { value, cached } = await jamaCache.getOrLoad(key, ttl, load);
    if (cached) this.http.stats.cacheHits += 1;
    return value;
  }

  async getProjects(): Promise<JamaProject[]> {
    return this.cached(['projects'], CACHE_TTL_MS.masterData, async () => {
      const { items } = await this.http.paginate<JamaProject>('projects', { limit: 500 });
      return items;
    });
  }

  async getProject(projectId: number): Promise<JamaProject | undefined> {
    const projects = await this.getProjects();
    return projects.find((project) => project.id === projectId);
  }

  async getItemTypes(): Promise<JamaItemType[]> {
    return this.cached(['itemtypes'], CACHE_TTL_MS.masterData, async () => {
      const { items } = await this.http.paginate<JamaItemType>('itemtypes', { limit: 300 });
      return items;
    });
  }

  async getItemType(itemTypeId: number): Promise<JamaItemType | undefined> {
    const types = await this.getItemTypes();
    return types.find((type) => type.id === itemTypeId);
  }

  async getRelationshipTypes(): Promise<JamaRelationshipType[]> {
    return this.cached(['relationshiptypes'], CACHE_TTL_MS.masterData, async () => {
      const { items } = await this.http.paginate<JamaRelationshipType>('relationshiptypes', {
        limit: 200,
      });
      return items;
    });
  }

  async getPickLists(): Promise<JamaPickList[]> {
    return this.cached(['picklists'], CACHE_TTL_MS.masterData, async () => {
      const { items } = await this.http.paginate<JamaPickList>('picklists', { limit: 500 });
      return items;
    });
  }

  async getPickListOptions(pickListId: number): Promise<JamaPickListOption[]> {
    return this.cached(['picklist', pickListId], CACHE_TTL_MS.masterData, async () => {
      const { items } = await this.http.paginate<JamaPickListOption>(
        `picklists/${pickListId}/options`,
        { limit: 500 },
      );
      return items;
    });
  }

  async getUsers(): Promise<JamaUser[]> {
    return this.cached(['users'], CACHE_TTL_MS.semiStatic, async () => {
      const { items } = await this.http.paginate<JamaUser>('users', { limit: 1000 });
      return items;
    });
  }

  /**
   * Baut eine Tabelle von Picklist-Options-ID auf Anzeigename. Es werden nur die
   * Picklists geladen, die von den Feldern des jeweiligen ItemTypes referenziert
   * werden — ein pauschales Laden aller Optionen waere bei grossen Instanzen
   * dutzende Aufrufe wert.
   */
  async getOptionLabels(itemTypeIds: number[]): Promise<Map<number, string>> {
    const types = await this.getItemTypes();
    const pickListIds = new Set<number>();

    for (const type of types) {
      if (!itemTypeIds.includes(type.id)) continue;
      for (const field of type.fields ?? []) {
        if (typeof field.pickList === 'number') pickListIds.add(field.pickList);
      }
    }

    const labels = new Map<number, string>();
    for (const pickListId of pickListIds) {
      const options = await this.getPickListOptions(pickListId);
      for (const option of options) {
        labels.set(option.id, option.name ?? option.value ?? String(option.id));
      }
    }
    return labels;
  }

  /** Anzeigenamen der Benutzer, fuer createdBy/modifiedBy/assignedTo. */
  async getUserLabels(): Promise<Map<number, string>> {
    const users = await this.getUsers();
    const labels = new Map<number, string>();
    for (const user of users) {
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
      labels.set(user.id, name || user.username || user.email || `Benutzer ${user.id}`);
    }
    return labels;
  }

  async getRelationshipTypeLabels(): Promise<Map<number, string>> {
    const types = await this.getRelationshipTypes();
    const labels = new Map<number, string>();
    for (const type of types) {
      labels.set(type.id, type.name ?? type.label ?? `Typ ${type.id}`);
    }
    return labels;
  }

  async getProjectLabels(): Promise<Map<number, string>> {
    const projects = await this.getProjects();
    const labels = new Map<number, string>();
    for (const project of projects) {
      labels.set(project.id, (project.fields?.name as string) ?? `Projekt ${project.id}`);
    }
    return labels;
  }

  /**
   * Aufbereitete Schema-Auskunft fuer das LLM: welche ItemTypes gibt es, welche
   * Felder tragen sie, welche Werte sind in Picklists erlaubt. Genau das, was
   * vor jedem Schreibvorgang bekannt sein muss.
   */
  async describeItemType(itemTypeId: number): Promise<{
    id: number;
    key?: string;
    name?: string;
    fields: Array<{
      name: string;
      label?: string;
      type?: string;
      required: boolean;
      readOnly: boolean;
      options?: string[];
    }>;
  } | undefined> {
    const type = await this.getItemType(itemTypeId);
    if (!type) return undefined;

    const fields = [];
    for (const field of type.fields ?? []) {
      const entry: {
        name: string;
        label?: string;
        type?: string;
        required: boolean;
        readOnly: boolean;
        options?: string[];
      } = {
        name: field.name,
        label: field.label,
        type: field.fieldType,
        required: field.required === true,
        readOnly: field.readOnly === true,
      };

      if (typeof field.pickList === 'number') {
        const options = await this.getPickListOptions(field.pickList);
        // Die Namen genuegen: beim Schreiben akzeptieren wir sie und loesen
        // selbst auf die IDs auf (siehe resolveFieldValues).
        entry.options = options
          .filter((option) => option.active !== false)
          .map((option) => option.name ?? option.value ?? String(option.id));
      }
      fields.push(entry);
    }

    return { id: type.id, key: type.typeKey, name: type.display, fields };
  }

  /**
   * Uebersetzt beim Schreiben Klartextwerte zurueck in die IDs, die Jama
   * erwartet. Ein LLM schreibt "Approved", Jama will 307.
   */
  async resolveFieldValues(
    itemTypeId: number,
    fields: Record<string, unknown>,
  ): Promise<{ resolved: Record<string, unknown>; warnings: string[] }> {
    const type = await this.getItemType(itemTypeId);
    const resolved: Record<string, unknown> = {};
    const warnings: string[] = [];

    if (!type) {
      return { resolved: { ...fields }, warnings: [`ItemType ${itemTypeId} ist unbekannt.`] };
    }

    const definitions = new Map((type.fields ?? []).map((field) => [field.name, field]));

    for (const [name, value] of Object.entries(fields)) {
      const definition = definitions.get(name);

      if (!definition) {
        // Nicht hart abweisen: Jama kennt Felder, die nicht in jeder
        // ItemType-Antwort auftauchen. Aber sichtbar machen.
        warnings.push(
          `Feld "${name}" ist im ItemType "${type.display ?? itemTypeId}" nicht definiert. Custom Fields tragen ein Suffix wie "${name}$${itemTypeId}".`,
        );
        resolved[name] = value;
        continue;
      }

      if (definition.readOnly) {
        warnings.push(`Feld "${name}" ist schreibgeschuetzt und wurde ignoriert.`);
        continue;
      }

      if (typeof definition.pickList === 'number' && typeof value === 'string') {
        const options = await this.getPickListOptions(definition.pickList);
        const match = options.find(
          (option) =>
            option.name?.toLowerCase() === value.toLowerCase() ||
            option.value?.toLowerCase() === value.toLowerCase(),
        );
        if (match) {
          resolved[name] = match.id;
          continue;
        }
        const allowed = options.map((option) => option.name ?? option.value).filter(Boolean);
        warnings.push(
          `Wert "${value}" ist fuer Feld "${name}" nicht zulaessig. Erlaubt sind: ${allowed.join(', ')}.`,
        );
        continue;
      }

      resolved[name] = value;
    }

    return { resolved, warnings };
  }

  /** Verwirft alle Stammdaten dieser Verbindung. */
  invalidate(): number {
    return jamaCache.invalidatePrefix(`${this.connectionId}:`);
  }
}
