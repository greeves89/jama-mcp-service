# TODO — jama-mcp-service

Konzept: [docs/KONZEPT.md](docs/KONZEPT.md) · Vergleich: [docs/vergleich-mcp.md](docs/vergleich-mcp.md) · Deployment: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

**Stand:** v1.2.0 · laeuft erstmals in einer echten Umgebung gegen eine reale Jama-Instanz

## Offen

- [ ] **Contract-Tests gegen die reale Instanz** — bisher wurden im Betrieb nur
      einzelne Tools benutzt. Je ein echter Aufruf pro lesendem Tool mit Abgleich
      des Antwortschemas steht aus; erst das deckt Abweichungen bei Feldnamen,
      Custom-Field-Suffixen und `labs`-Endpunkten flaechendeckend auf
- [ ] **Schreibende Tools erstmals gegen die reale Instanz pruefen** — bisher nur
      lesend im Einsatz. Zuerst mit `dryRun`, in einem unkritischen Projekt
- [ ] **Verfuegbarkeit der `labs`-Endpunkte klaeren** (Reviews ab 9.32, Reports ab
      8.79) — entscheidet, ob die Toolsets `review` und Teile von `files` nutzbar sind
- [ ] **Lizenzlage bestaetigen** — REST-Zugriff nur mit Named-Creator-Lizenz.
      Der Verbindungstest im Dashboard zeigt den Lizenztyp an
- [ ] Benutzerhandbuch fuer das Dashboard mit Screenshots

## Offen — vor breiterem Rollout

- [ ] Zweiter Faktor (TOTP) oder IP-Allowlist fuer das Dashboard, sobald es
      ueber das interne Netz hinaus erreichbar ist
- [ ] Backup-Konzept fuer die Datenbank
- [ ] `ADMIN_INITIAL_PIN` nach dem ersten Start aus der Umgebung entfernen
- [ ] Ungenutzte API-Keys regelmaessig pruefen — das Dashboard markiert sie nach
      60 Tagen ohne Nutzung

## Offen — Ausbau

- [ ] Geteilter Cache (Redis), sobald mehr als eine Instanz laeuft.
      Das Cache-Interface in `src/jama/cache.ts` ist dafuer vorbereitet
- [ ] Aggregat-Tabellen und Partitionierung fuer `usage_events`, sobald die
      Datenmenge waechst
- [ ] `jama_get_project_details` als eigenes Tool
- [ ] Semantische Suche (Jamas API kann nur Text)
- [ ] OAuth-Token-Abruf durch den Rate-Limiter fuehren

## Erledigt

- [x] Konzept mit 51 Anwendungsfaellen, Vergleich mit dem offiziellen Jama-MCP
- [x] Jama-Client: OAuth und Basic Auth, Token-Bucket, Fibonacci-Backoff,
      Pagination, Stammdaten-Cache, HTML→Markdown, Picklist-Aufloesung
- [x] MCP-Server: Streamable HTTP und stdio, Key-Auth, Toolset-Gating,
      Nutzungs- und Audit-Protokollierung, Antwortbudget
- [x] 53 Tools in 8 Toolsets, 5 Prompts, 2 Resources
- [x] Admin-Dashboard mit 9 Seiten, PIN mit Argon2id, IP-Sperre, CSRF
- [x] Einzelne Tools instanzweit abschaltbar (v1.1.0)
- [x] 101 Tests inklusive MCDC-Matrizen
- [x] Docker: vollstaendiger Stack, Traefik-Variante, Datenbank-Netz-Override
- [x] Deployment-Anleitung fuer Portainer und bestehende Infrastruktur
- [x] Oeffentliches Repository, MIT-Lizenz
- [x] **Erstinbetriebnahme in einer fremden Umgebung** — laeuft gegen eine reale
      Jama-Instanz, Tool-Aufrufe aus einem LLM-Client kommen an

## Behobene Fehler

- **API-Key-Zerlegung brach an Unterstrichen** — base64url-Secrets enthalten `_`,
  `split('_')` lieferte zu viele Teile. Jede Anmeldung waere fehlgeschlagen.
  Gefunden durch die Tests
- **Datei-Upload ohne gueltige Anmeldung** — der Multipart-Pfad umging den
  HTTP-Kern und hatte einen Platzhalter im Authorization-Header
- **Zwei HIGH-Schwachstellen in Abhaengigkeiten** — SQL-Injection und Path
  Traversal, durch Aktualisierung behoben
- **Docker-Build scheiterte auf einem frischen Klon** — `npm ci` hoistet bei
  Workspaces alle Abhaengigkeiten; das erwartete `web/node_modules` entstand nie.
  Lokal fiel es nur nicht auf, weil dort ein leeres Verzeichnis zurueckgeblieben war
- **Fuenf Dashboard-Funktionen scheiterten mit HTTP 400** — `Content-Type:
  application/json` wurde auch ohne Nutzlast gesetzt. Betraf Verbindungstest,
  Key-Rotation, Loeschen, Cache leeren und Abmelden. Im Betrieb gefunden
- **Projekte waren ueber ihren Schluessel nicht auffindbar** — der Filter
  durchsuchte allein den Namen, womit es keinen Weg von der Kennung zur internen
  ID gab. Im Betrieb gefunden
