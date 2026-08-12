# TODO — jama-mcp-service

Konzept: [docs/KONZEPT.md](docs/KONZEPT.md) · Vergleich: [docs/vergleich-mcp.md](docs/vergleich-mcp.md)

**Stand:** v1.0.0 fertiggestellt am 2026-08-12. Alle Phasen 0 bis 8 umgesetzt.

## Blocked — vor dem produktiven Einsatz

- [ ] **Zugangsdaten für eine Jama-Test-Instanz beschaffen** (OAuth Client-ID/Secret).
      Der Dienst ist noch nie gegen ein reales Jama gelaufen. Ungeprüft sind:
      Feldnamen, Custom-Field-Suffixe (`feld$NN`), Verfügbarkeit der `labs`-Endpunkte
      (Reviews, Reports, Baseline-Anlage), das genaue Antwortformat von
      `POST /items` und `GET /rest`
- [ ] **Contract-Tests gegen die Test-Instanz schreiben und ausführen** — je ein
      echter Aufruf pro lesendem Tool, mit Abgleich des Antwortschemas
- [ ] **Jama-Version der Zielinstanz klären** — entscheidet über die Toolsets
      `review` (ab 9.32) und `files`/Reports (ab 8.79)
- [ ] **Lizenzlage prüfen** — REST-Zugriff nur mit Named-Creator-Lizenz.
      Creator-Float hat keinen API-Zugang. Begrenzt den Nutzerkreis
- [ ] **Entscheiden: offizieller Jama MCP, Eigenbau oder beides** — Grundlage
      steht in [docs/vergleich-mcp.md](docs/vergleich-mcp.md). Offen ist, ob der
      offizielle MCP für die Zielinstanz freigeschaltet ist und zu welchen Konditionen

## Pending — vor einer Exposition ins Internet

- [ ] Zweiter Faktor (TOTP) oder IP-Allowlist im nginx für das Admin-Dashboard.
      Der PIN allein ist für den lokalen Betrieb ausgelegt
- [ ] TLS im nginx (Zertifikate, HSTS ist bereits vorbereitet)
- [ ] Server-Härtung: Firewall, nur Ports 22/80/443
- [ ] Backup-Konzept für das Postgres-Volume
- [ ] `ADMIN_INITIAL_PIN` nach dem ersten Start aus der `.env` entfernen

## Pending — Ausbau

- [ ] Geteilter Cache (Redis), sobald mehr als eine Instanz läuft.
      Das Cache-Interface in `src/jama/cache.ts` ist dafür vorbereitet
- [ ] Aggregat-Tabellen für die Dashboard-Kacheln, sobald `usage_events` groß wird
      (derzeit wird über die Rohdaten aggregiert)
- [ ] Monatliche Partitionierung von `usage_events`
- [ ] `jama_get_project_details` als eigenes Tool — der offizielle MCP hat es,
      bei uns steckt es nur teilweise in `jama_list_projects`
- [ ] Semantische Suche (Jamas API kann nur Text; bräuchte eigene Indizierung)
- [ ] OAuth-Token-Abruf durch den Rate-Limiter führen (derzeit umgeht er ihn;
      bei einer Stunde Token-Laufzeit nicht relevant)
- [ ] Benutzerhandbuch für das Admin-Dashboard mit Screenshots

## Completed

- [x] API-Dokumentation ausgewertet, Konzept mit 51 Anwendungsfällen erstellt (2026-08-12)
- [x] Phase 0: Repo, Docker, nginx, Postgres, Drizzle-Schema, Secret-Erzeugung (2026-08-12)
- [x] Phase 1: Jama-Client — OAuth und Basic Auth, Token-Cache, Token-Bucket,
      Fibonacci-Backoff, Pagination, Stammdaten-Cache, HTML→Markdown,
      Picklist-Auflösung, Fehlerübersetzung (2026-08-12)
- [x] Phase 2: MCP-Grundgerüst — Streamable HTTP und stdio, Key-Authentifizierung,
      Toolset-Gating, Nutzungs- und Audit-Protokollierung, Antwortbudget (2026-08-12)
- [x] Phase 3: Toolsets `core` (11) und `trace` (5) (2026-08-12)
- [x] Phase 4: Admin-Backend — PIN mit Argon2id, IP-Sperre, CSRF, Key- und
      Verbindungsverwaltung, Nutzungsauswertung (2026-08-12)
- [x] Phase 5: Admin-Dashboard mit 9 Seiten (2026-08-12)
- [x] Phase 6: Toolsets `write` (12) und `collab` (4) mit Guards und Trockenlauf (2026-08-12)
- [x] Phase 7: Toolsets `test` (7), `history` (6), `review` (3), `files` (5) (2026-08-12)
- [x] Phase 8: Komposit-Tools, 5 MCP Prompts, 2 MCP Resources (2026-08-12)
- [x] 86 Tests inklusive MCDC-Matrizen für Guards, Rate-Limiter, Verschlüsselung,
      Wiederholungslogik und Aufbereitung (2026-08-12)
- [x] End-zu-Ende gegen echte PostgreSQL geprüft: Anmeldung, Sperre, CSRF,
      Key-Anlage, MCP-Handshake, Toolset-Gating, Fehlerpfad, Nutzungserfassung (2026-08-12)
- [x] Sicherheitsdurchsicht: keine Secrets im Code, keine SQL-Konkatenation,
      Credentials verlassen den Server nie, Cookie-Flags korrekt (2026-08-12)
- [x] README, CHANGELOG, MIT-Lizenz, Vergleichsdokument als PDF (2026-08-12)

## Behobene Fehler

- **API-Key-Zerlegung brach an Unterstrichen** — das Secret wird base64url
  kodiert und enthält damit `_`. Die Zerlegung per `split('_')` lieferte zu
  viele Teile, jede Anmeldung wäre fehlgeschlagen. Gefunden durch die Tests,
  behoben durch ein hexadezimales Präfix und Zerlegung per Muster
- **Datei-Upload ohne gültige Anmeldung** — der Multipart-Upload umging den
  HTTP-Kern und hatte einen Platzhalter im Authorization-Header. In
  `JamaHttp.uploadFile()` überführt, inklusive Rate-Limiting und Fehlerbehandlung
- **Zwei HIGH-Schwachstellen in Abhängigkeiten** — SQL-Injection in `drizzle-orm`
  und Path Traversal in `@fastify/static`, beide durch Aktualisierung behoben
