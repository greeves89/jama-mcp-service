# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier festgehalten.
Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung [Semantic Versioning](https://semver.org/lang/de/).

## [1.0.0] — 2026-08-12

Erste Fassung.

### Hinzugefügt

**MCP-Server**
- 53 Tools in 8 einzeln freischaltbaren Toolsets (`core`, `trace`, `write`,
  `collab`, `test`, `history`, `review`, `files`)
- Streamable HTTP als Hauptbetriebsart, stdio für den Einzelplatz ohne Datenbank
- 5 vorgefertigte Abläufe (MCP Prompts) und 2 Resources
- Komposit-Tools, die jeweils Dutzende Einzelaufrufe ersetzen:
  `jama_trace_chain`, `jama_find_trace_gaps`, `jama_trace_matrix`,
  `jama_compare_baselines`, `jama_testcycle_summary`

**Jama-Anbindung**
- OAuth 2.0 Client Credentials mit Token-Zwischenspeicher, Basic Auth als Rückfall
- Token-Bucket je Verbindung, standardmäßig unter Jamas Grenze von 10 Anfragen
  pro Sekunde
- Wiederholung nach HTTP 429 mit Fibonacci-Backoff (3/5/8/13 Sekunden) und Streuung
- Pagination unter Beachtung der Seitengrenze von 50
- Zwischenspeicher für Stammdaten (ItemTypes, Picklists, Projekte, Benutzer)
- Aufbereitung der Antworten: HTML nach Markdown, Auflösung von Picklist-Werten
  und Benutzer-IDs, Ersetzung eingebetteter Bilder, Begrenzung auf ein Token-Budget

**Schutzschichten**
- Toolset-Prüfung, Read-only-Prüfung, Bestätigungspflicht bei löschenden Tools,
  Projekt-Allowlist
- Globale Notbremse, die alle schreibenden Tools sofort sperrt
- Trockenlauf als Standard bei Massenoperationen
- Redigieren von Geheimnissen und langen Freitexten vor dem Protokollieren

**Admin-Dashboard**
- PIN-Anmeldung mit Argon2id, IP-Sperre nach fünf Fehlversuchen, CSRF-Schutz
- Verwaltung von API-Keys inklusive Rotation, Ablauf, Deaktivierung und
  fertigem Konfigurationsschnipsel für MCP-Clients
- Verwaltung von Jama-Verbindungen mit Verbindungstest und Lizenzprüfung
- Nutzungsauswertung mit Latenzen, Fehlerquoten, Cache-Trefferquote und
  geschätztem Token-Verbrauch je Tool
- Audit-Log mit CSV-Export
- Aufruf-Explorer mit Aufwand je Tool-Aufruf
- Tool-Katalog mit Probelauf gegen eine gewählte Verbindung

**Betrieb**
- docker-compose mit nginx als einzigem Zugang von außen; Datenbank ohne
  Port-Mapping, persistente Daten in einem benannten Volume
- Mehrstufiges Dockerfile, Laufzeit ohne Build-Werkzeuge und ohne root
- Health-Checks für alle Dienste
- Migrationen laufen beim Start mit
- Stündliche Wartung: Aufbewahrungsfristen, abgelaufene Sitzungen, Cache

**Qualitätssicherung**
- 86 Tests, darunter MCDC-Matrizen für Schutzschichten, Rate-Limiter,
  Verschlüsselung und Wiederholungslogik
- End-zu-Ende-Prüfung gegen eine echte PostgreSQL

### Bekannte Einschränkungen
- Noch nicht gegen eine reale Jama-Instanz verifiziert
- Massenoperationen sind nicht atomar
- `labs`-Endpunkte (Reviews, Reports) ohne Supportzusage von Jama
- Zwischenspeicher liegt im Prozess, nicht geteilt
