# Erweiterung: Personenbezogene Rechte

Verbindlicher Vertrag fuer den Ausbau. Wer etwas baut, haelt sich an die hier
festgelegten Signaturen und Pfade; wer etwas braucht, darf sich darauf
verlassen. Abweichungen gehoeren erst hierher und dann in den Code.

## Warum

Heute haengen Rechte am **Zugang**: `api_keys.allowed_project_ids`,
`read_only`, `toolsets`. Eine Zahlenliste, von Hand eingetippt. Teilen sich
mehrere Menschen einen Zugang — der Regelfall bei einem Chatwerkzeug —, haben
alle dieselben Rechte.

Gebraucht wird: **wer** darf **welches Projekt** **lesen oder aendern**.

## Die drei Stufen, in dieser Rangfolge

1. **Sperrliste** (`gesperrteProjektIds`). Gilt immer und hebt nichts auf.
   Gedacht fuer Bereiche, die niemand ueber diese Anbindung sehen soll.
2. **Zugangsfreigabe** (`allowedProjectIds`, bestehend). Die Obergrenze des
   Zugangs. Eine Zuordnung kann **nie mehr** erlauben als der Zugang hergibt.
3. **Personenzuordnung** (neu). Schraenkt innerhalb der Obergrenze weiter ein.

Effektiv sichtbar ist ein Projekt also nur, wenn es **keine** Sperre trifft,
**die Zugangsfreigabe** es einschliesst **und** die Person es zugeordnet
bekommen hat. Aenderbar zusaetzlich nur, wenn der Zugang nicht schreibgeschuetzt
ist und die Person Schreibrecht an genau diesem Projekt hat.

Diese Reihenfolge ist nicht verhandelbar. Wer sie umdreht, baut eine Matrix,
die die bestehende Mandantengrenze aushebelt.

## Datenmodell (neu in `src/db/schema.ts`)

```ts
jamaBenutzer     // Spiegel aus Jama, nicht Quelle
  id uuid pk
  jamaUserId integer notNull unique
  username text, email text, firstName text, lastName text
  licenseType text            // 'CREATOR' | 'FLOAT' | 'STAKEHOLDER' | 'REVIEWER' | …
  aktiv boolean default true  // in Jama deaktiviert => false
  abgeglichenAm timestamptz

jamaProjekte     // Spiegel aus Jama
  id uuid pk
  jamaProjectId integer notNull unique
  projectKey text, name text
  elternId integer            // Jama-ProjectId des Ordners darueber, null bei Wurzel
  istOrdner boolean
  archiviert boolean default false
  abgeglichenAm timestamptz

personenrechte   // die Zuordnung
  id uuid pk
  jamaUserId integer notNull      // bewusst die Jama-Nummer, nicht die uuid:
                                  // sie ueberlebt einen Neuaufbau des Spiegels
  jamaProjectId integer notNull
  stufe text notNull              // 'lesen' | 'schreiben'
  vergebenAm timestamptz, vergebenVon text
  unique (jamaUserId, jamaProjectId)

personenvorgabe  // damit nicht 240 Personen einzeln geklickt werden muessen
  jamaUserId integer pk
  grundstufe text notNull default 'lesen'   // 'keine' | 'lesen' | 'schreiben'
  notiz text
```

Ergaenzung an `api_keys`:
```ts
gesperrteProjektIds: integer('gesperrte_projekt_ids').array().notNull().default([])
personenrechteAktiv: boolean('personenrechte_aktiv').notNull().default(false)
```

**Warum je Zugang abschaltbar:** Die Matrix wird nicht schlagartig scharf
geschaltet. Ein Zugang laeuft weiter wie bisher, bis er umgestellt wird.

## Die reine Berechnung (neu: `src/mcp/rechte.ts`)

Kein Datenbankzugriff, keine Ein- und Ausgabe, vollstaendig testbar.

```ts
export type Stufe = 'keine' | 'lesen' | 'schreiben';

export interface Personenlage {
  /** Wird die Matrix fuer diesen Zugang angewandt? */
  aktiv: boolean;
  /** Konnte die aufrufende Person zugeordnet werden? */
  erkannt: boolean;
  grundstufe: Stufe;
  lesen: number[];
  schreiben: number[];
}

export interface Rechtelage {
  gesperrteProjektIds: number[];
  allowedProjectIds: number[];
  readOnly: boolean;
  person: Personenlage;
  /** Was gilt, wenn die Matrix aktiv ist, die Person aber unbekannt bleibt. */
  beiUnbekannt: 'ablehnen' | 'nur_lesen';
}

export function darfLesen(projectId: number | undefined, lage: Rechtelage): boolean;
export function darfAendern(projectId: number | undefined, lage: Rechtelage): boolean;
export function begruendung(projectId: number, lage: Rechtelage): string;
```

**`beiUnbekannt` steht auf `'nur_lesen'` als Vorgabe, und das ist wichtig.**
Open WebUI reicht die Benutzer-Kopfzeilen derzeit nicht an MCP-Server ueber
Streamable HTTP weiter (siehe `src/mcp/aufrufer.ts`). Waere die Vorgabe
`'ablehnen'`, wuerde das Scharfschalten der Matrix den laufenden Betrieb
lahmlegen. Mit `'nur_lesen'` bleibt Lesen moeglich und Schreiben wird
abgelehnt, bis die Identitaet ankommt.

`projectId === undefined` bedeutet: Der Aufruf nennt kein Projekt. Dann greift
die Projektpruefung nicht — so wie heute auch.

## Durchsetzung

`ToolContext` (in `src/mcp/types.ts`) bekommt ein Feld:
```ts
rechte: Rechtelage;
```
Die bestehenden Felder `allowedProjectIds` und `readOnly` bleiben, damit
nichts bricht. Sie sind ab dann redundant zu `rechte` — das ist bewusst so und
wird spaeter aufgeraeumt, nicht in diesem Zug.

In `src/mcp/guards.ts` werden `assertProjectAllowed`, `istProjektErlaubt`,
`filterByAllowedProjects` und `sichtbareTrefferzahl` auf `rechte` umgestellt.
**Die Signaturen bleiben unveraendert** — sechsundfuenfzig Aufrufstellen haengen
daran. `assertWriteAllowed` prueft zusaetzlich `darfAendern`, sobald das
Projekt bekannt ist.

## Abgleich (neu: `src/service/abgleich.ts`)

```ts
export interface Abgleichsergebnis {
  benutzer: { neu: number; geaendert: number; verschwunden: number };
  projekte: { neu: number; geaendert: number; verschwunden: number };
  dauerMs: number;
  warnungen: string[];
}
export async function gleicheAb(connectionId: string, von: string): Promise<Abgleichsergebnis>;
export async function letzterAbgleich(): Promise<{ am: Date | null; benutzer: number; projekte: number }>;
```

Holt Benutzer und Projekte ueber die vorhandene Jama-Anbindung. Die Abfragen
gibt es bereits als Werkzeuge (`jama_list_users`, `jama_list_projects`); die
Logik wird aus ihnen herausgezogen, nicht abgeschrieben.

**Verschwunden heisst nicht geloescht.** Wer in Jama deaktiviert wurde, wird
hier auf `aktiv = false` gesetzt und bleibt stehen — sonst verliert die
Zuordnung ihren Bezugspunkt und mit ihr die Nachvollziehbarkeit.

## Verwaltung (neu: `src/service/personen.ts`)

```ts
ladePersonen(filter?): Promise<Personenzeile[]>          // mit Anzahl zugeordneter Projekte
ladeProjekte(filter?): Promise<Projektzeile[]>           // als Baum, mit elternId
ladeZuordnung(jamaUserId): Promise<{ lesen: number[]; schreiben: number[]; grundstufe: Stufe }>
setzeZuordnung(jamaUserId, projectId, stufe: Stufe, von: string): Promise<void>
setzeGrundstufe(jamaUserId, stufe: Stufe, von: string): Promise<void>
setzeZuordnungMehrfach(jamaUserId, eintraege: Array<{projectId:number; stufe:Stufe}>, von): Promise<void>
```

Jede veraendernde Funktion schreibt ins Audit-Log, ueber denselben Weg wie
`src/service/keys.ts`.

## Schnittstelle (in `src/admin/routes.ts`)

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/admin/api/abgleich` | Abgleich anstossen, liefert `Abgleichsergebnis` |
| GET | `/admin/api/abgleich` | Zeitpunkt und Umfang des letzten Abgleichs |
| GET | `/admin/api/personen` | Liste, mit `q` und `nurMitZuordnung` |
| GET | `/admin/api/personen/:jamaUserId` | eine Person samt Zuordnung |
| PUT | `/admin/api/personen/:jamaUserId/grundstufe` | `{ stufe }` |
| PUT | `/admin/api/personen/:jamaUserId/zuordnung` | `{ eintraege: [{projectId, stufe}] }` |
| GET | `/admin/api/projekte` | Projektbaum aus dem Spiegel |
| PATCH | `/admin/api/keys/:id` | erweitert um `gesperrteProjektIds`, `personenrechteAktiv` |

Alle unter demselben Anmeldeschutz wie die uebrigen Admin-Routen.

## Oberflaeche (`web/src/pages/`)

**`Personen.tsx`** — Liste aus dem Spiegel: Name, Anmeldename, Lizenztyp,
Grundstufe, Anzahl zugeordneter Projekte, zuletzt genutzt. Suche. Kopfzeile
mit Abgleich-Knopf und Zeitpunkt des letzten Abgleichs.

**`Zuordnung.tsx`** — links die Person waehlen, rechts der Projektbaum mit je
Zeile drei Schaltern: keine / lesen / schreiben. Mehrfachauswahl ueber den
Baum (ein Ordner setzt alles darunter). Speichern in einem Zug.

Beide folgen dem Muster der vorhandenen Seiten. **Nur lucide-Symbole, keine
Emojis, echte Umlaute in allen sichtbaren Texten.**

## Harte Vorgaben

- SQL nur ueber Drizzle, parametrisiert.
- Keine Kunden-, Firmen- oder Personennamen in Code, Kommentaren, Tests oder
  Beispieldaten. Beispiele mit `example.com`.
- Kommentare auf Deutsch; sie begruenden Entscheidungen, nicht was die Zeile tut.
- Keine TODOs, keine toten Pfade.
