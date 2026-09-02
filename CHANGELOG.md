# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier festgehalten.
Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung [Semantic Versioning](https://semver.org/lang/de/).

## [1.2.0] — 2026-09-02

### Behoben
- **Verbindungstest, Key-Rotation, Loeschen, Cache leeren und Abmelden schlugen
  im Dashboard mit HTTP 400 fehl.** Die Admin-Oberflaeche setzte bei jeder
  Anfrage `Content-Type: application/json`, auch dort, wo gar keine Nutzlast
  mitging. Der Server weist eine solche Anfrage ab, weil sie einen JSON-Koerper
  ankuendigt und keinen liefert. Der Header wird nun nur noch bei tatsaechlich
  vorhandenem Body gesetzt.
- **Projekte liessen sich nicht ueber ihren Schluessel finden.** Der Filter
  `contains` in `jama_list_projects` durchsuchte ausschliesslich den Projektnamen.
  Ein Projektkuerzel — also die Kennung, die Menschen und Fremdsysteme meist
  nennen — fuehrte zu keinem Treffer, und es gab keinen Weg, daraus die interne
  numerische Projekt-ID abzuleiten, die alle uebrigen Tools verlangen. Der Filter
  durchsucht nun Name, Projektschluessel, Beschreibung und ID.

### Hinzugefuegt
- `jama_search_items` akzeptiert alternativ zur `projectId` einen `projectKey`
  und loest ihn selbst auf. Exakte Treffer gehen Teiltreffern vor; bei mehreren
  Kandidaten werden diese benannt, statt einen zu raten. Bleibt die Suche leer,
  nennt die Meldung auch fehlende Berechtigungen als moegliche Ursache.
- `docker-compose.dbnet.yml`: Override, das die Anwendung zusaetzlich an das Netz
  der Datenbank haengt. Noetig, sobald Reverse-Proxy und Datenbank in
  verschiedenen Docker-Netzen liegen — der Regelfall, wenn die Datenbank zu einem
  anderen Stack gehoert.
- 8 Tests fuer die Aufloesung von Projektkennungen.

### Geaendert
- Der `certresolver` ist in `docker-compose.traefik.yml` nicht mehr fest gesetzt.
  Viele Traefik-Installationen verwalten Zertifikate zentral und kennen gar
  keinen Resolver; ein unbekannter Name laesst den Router dort stillschweigend
  scheitern. Die Zeile steht auskommentiert bereit.

## [1.1.0] — 2026-08-12

### Hinzugefügt
- **Einzelne Tools instanzweit abschalten.** Im Tool-Katalog lässt sich jedes der
  53 Tools abschalten und wieder freigeben. Abgeschaltete Tools werden am
  MCP-Server gar nicht erst registriert und erscheinen in keinem Client —
  unabhängig davon, welche Toolsets ein Zugang hat. Damit ist etwa möglich:
  das Toolset `write` freigeben, aber `jama_delete_item` dauerhaft sperren.
  Im stdio-Betrieb über `JAMA_DISABLED_TOOLS` steuerbar.
- Neuer Guard `assertToolEnabled` als erste Prüfung in der Kette, plus
  Fehlercode `TOOL_DISABLED`.
- `docker-compose.traefik.yml` für Umgebungen, in denen Traefik und PostgreSQL
  bereits laufen — startet nur die Anwendung.
- Deployment-Anleitung für Portainer und für bestehende Infrastruktur
  ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

### Geändert
- Version auf 1.0.0 vereinheitlicht (`package.json` stand auf 0.1.0, während
  CHANGELOG und Health-Endpunkt bereits 1.0.0 meldeten).

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
