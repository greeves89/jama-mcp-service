# jama-mcp-service

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Tests](https://img.shields.io/badge/Tests-86%20passing-brightgreen.svg)](tests/)
[![Tools](https://img.shields.io/badge/MCP%20Tools-53-8A2BE2.svg)](#toolsets)

MCP-Server für [Jama Connect](https://www.jamasoftware.com/) mit einem Admin-Dashboard
für die Verwaltung von Zugängen und die Auswertung der Nutzung.

Der Dienst bringt Anforderungen, Traceability, Tests und Baselines aus Jama in
MCP-fähige Clients wie Claude, Cursor, VS Code oder GitHub Copilot — und behält
dabei die Kontrolle darüber, wer was tun darf und was tatsächlich passiert ist.

- **53 Tools** in 8 einzeln freischaltbaren Toolsets
- **Zwei Betriebsarten:** Streamable HTTP für den gemeinsamen Betrieb, stdio für den Einzelplatz
- **Eigene Zugangsverwaltung** mit Rotation, Ablauf, Projekt-Allowlist und Read-only-Standard
- **Audit-Trail** über jede verändernde Operation, als CSV exportierbar
- **Rate-Limit-Steuerung**, die Jamas Grenze von 10 Anfragen pro Sekunde respektiert

> **Stand der Erprobung:** Die Logik ist durch 86 Tests gegen Fixtures abgedeckt und
> der Dienst wurde end-to-end gegen eine echte PostgreSQL geprüft. Gegen eine reale
> Jama-Instanz ist er **noch nicht verifiziert**. Feldnamen, Custom-Field-Suffixe und
> die Verfügbarkeit der `labs`-Endpunkte sollten vor dem produktiven Einsatz gegen
> eine Test-Instanz geprüft werden.

## Verhältnis zum offiziellen Jama Connect MCP

Seit Mai 2026 bietet Jama einen [eigenen MCP-Server](https://www.jamasoftware.com/press/jama-software-launches-model-context-protocol-mcp-server/)
an (ab Jama Connect 9.35, Freischaltung je Tenant erforderlich). Er umfasst 18 Tools
und schließt Massenoperationen, Multi-Call-Transaktionen und Bulk-Export
ausdrücklich aus.

Dieser Dienst deckt alle 18 offiziellen Tools mit 15 eigenen ab. Die übrigen
**38 Tools haben beim offiziellen Server keine Entsprechung** — darunter drei
Bereiche, die dort vollständig fehlen:

- **Test-Management** (7 Tools) — Testpläne, Testzyklen, Testläufe, Zyklus-Auswertung
- **Traceability-Auswertung** (4 Tools) — Ketten verfolgen, Abdeckungslücken finden,
  Zuordnungsmatrix, Regelprüfung
- **Baseline-Vergleich und Historie** (4 Tools) — feldweiser Unterschied zwischen
  zwei Ständen, Versionshistorie, Aktivitäten, Wiederherstellung

Dazu Massenoperationen mit Trockenlauf, Anhänge, Reviews, gespeicherte Filter
sowie eine eigene Verwaltung von Zugängen, Nutzung und Nachweisen.

Der Preis dafür ist, dass Betrieb, Pflege und die Aufbewahrung der
Jama-Zugangsdaten in eigener Verantwortung liegen.

Eine ausführliche Gegenüberstellung steht in [docs/vergleich-mcp.md](docs/vergleich-mcp.md).

## Schnellstart

Voraussetzungen: Docker und Docker Compose. Für die Entwicklung zusätzlich Node.js 22.

```bash
git clone <repository-url> jama-mcp-service
cd jama-mcp-service

# Erzeugt .env mit frischen Secrets und gibt den Admin-PIN aus.
npm install
npm run secrets

docker compose up -d --build
```

Das Dashboard ist danach unter <http://localhost:8081/admin/> erreichbar. Der PIN
steht in der Ausgabe von `npm run secrets` — er wird nur als Hash gespeichert und
lässt sich nicht wiederherstellen.

### Erste Schritte im Dashboard

1. **Verbindungen** → eine Jama-Instanz anlegen (Basis-URL und OAuth-Zugangsdaten).
   OAuth ist der empfohlene Weg; Basic Auth funktioniert in SSO-Umgebungen nicht.
2. **Verbindung testen** — der Test meldet den angemeldeten Benutzer und dessen
   Lizenztyp. Der REST-Zugriff erfordert eine **Named-Creator-Lizenz**;
   Creator-Float-Lizenzen haben gar keinen API-Zugang.
3. **API-Keys** → einen Zugang anlegen. Der Key wird genau einmal angezeigt,
   zusammen mit einem fertigen Konfigurationsschnipsel für den MCP-Client.

### Deployment auf einem Server

Für Portainer, Traefik oder einen anderen Reverse-Proxy siehe
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Portainer baut den Stack direkt aus
diesem Repository — es genügt die Repository-URL plus vier Umgebungsvariablen.

### Anbindung eines MCP-Clients

```json
{
  "mcpServers": {
    "jama": {
      "type": "http",
      "url": "http://localhost:8081/mcp",
      "headers": { "Authorization": "Bearer jama_mcp_..." }
    }
  }
}
```

## Betriebsarten

### Streamable HTTP (empfohlen)

Der Standardbetrieb. Mehrere Personen teilen sich einen Dienst, jede mit eigenem
API-Key und eigenen Jama-Zugangsdaten. Nutzung und verändernde Operationen werden
protokolliert.

### stdio (Einzelplatz)

Für Entwickler, die den Server lokal ohne Datenbank betreiben wollen. Zugangsdaten
kommen aus der Umgebung; es gibt weder Nutzungsauswertung noch Audit-Trail —
deshalb ist dieser Modus standardmäßig auf Lesen beschränkt.

```json
{
  "mcpServers": {
    "jama": {
      "command": "node",
      "args": ["/pfad/zu/jama-mcp-service/dist/stdio.js"],
      "env": {
        "JAMA_BASE_URL": "https://beispiel.jamacloud.com",
        "JAMA_CLIENT_ID": "...",
        "JAMA_CLIENT_SECRET": "...",
        "JAMA_TOOLSETS": "core,trace"
      }
    }
  }
}
```

Weitere Variablen: `JAMA_READ_ONLY=false` schaltet das Schreiben frei,
`JAMA_ALLOWED_PROJECTS` begrenzt auf Projekt-IDs, `JAMA_TOOLSETS=all` aktiviert alle.

## Toolsets

Toolsets werden je API-Key freigeschaltet. Ein Zugang sieht nur die Tools seiner
Toolsets — das begrenzt den Schaden eines kompromittierten Keys und hält zugleich
die Tool-Liste im Kontextfenster klein.

| Toolset | Tools | Schreibend | Inhalt |
|---|---|---|---|
| `core` | 11 | nein | Projekte, Schema, Suche, Item-Details, Baumnavigation, gespeicherte Filter, Releases, Tags, Benutzer |
| `trace` | 5 | nein | Beziehungen, Traceability-Ketten, Abdeckungslücken, Zuordnungsmatrix, Regelprüfung |
| `write` | 12 | ja | Items und Container anlegen, ändern, verschieben, duplizieren, löschen; Beziehungen und Tags; Sperren |
| `collab` | 4 | ja | Kommentare lesen und schreiben, Workflow-Übergänge |
| `test` | 7 | ja | Testpläne, Testzyklen, Testläufe, Zyklus-Auswertung |
| `history` | 6 | ja | Baselines anlegen und vergleichen, Versionshistorie, Aktivitäten, Wiederherstellung |
| `review` | 3 | nein | Reviews, Fortschritt, Review-Kommentare (`labs`, ab Jama 9.32) |
| `files` | 5 | ja | Anhänge auflisten, hoch- und herunterladen; Reports (`labs`, ab Jama 8.79) |

Standard beim Anlegen eines Keys: `core` und `trace`, nur lesend.

### Bemerkenswerte Tools

- **`jama_get_project_schema`** — liefert ItemTypes, Feldnamen und zulässige
  Picklist-Werte. Vor jedem Schreibvorgang erforderlich, weil Custom Fields ein
  Suffix wie `priority$32` tragen, das sich nicht erraten lässt.
- **`jama_trace_chain`** — verfolgt Verknüpfungsketten über mehrere Ebenen mit
  Zyklenerkennung. Ersetzt Dutzende Einzelaufrufe.
- **`jama_find_trace_gaps`** — findet Items ohne geforderte Verknüpfung. Das
  Werkzeug für Nachweise nach ASPICE, ISO 26262 oder IEC 62304.
- **`jama_compare_baselines`** — feldweiser Unterschied zwischen zwei Ständen.
  Jama selbst liefert nur die beiden Bestandslisten.
- **`jama_bulk_create_items` / `jama_bulk_update_items`** — Massenoperationen mit
  verpflichtendem Trockenlauf (`dryRun` ist standardmäßig aktiv).

## Sicherheit

- **Zwei getrennte Auth-Ebenen.** Der API-Key identifiziert den Zugang beim Dienst
  (gespeichert wird nur ein SHA-256-Hash). Daraus ergeben sich die Jama-Zugangsdaten,
  mit denen der Dienst gegenüber Jama auftritt (AES-256-GCM-verschlüsselt).
- **Keine Rechteausweitung.** Empfohlen sind eigene Jama-Zugangsdaten je Person.
  Jamas Berechtigungen bleiben wirksam; der Dienst schränkt höchstens weiter ein.
- **Guards vor jedem Aufruf:** Toolset-Prüfung, Read-only-Prüfung,
  Bestätigungspflicht bei löschenden Tools, Projekt-Allowlist.
- **Globale Notbremse** im Dashboard sperrt alle schreibenden Tools sofort.
- **Nur nginx nach außen.** Anwendung und Datenbank sind lediglich im internen
  Docker-Netz erreichbar; die Datenbank hat gar kein Port-Mapping.
- **Prompt Injection:** Jama-Inhalte sind Fremddaten. Der Dienst kennzeichnet sie
  als Daten; verändernde Tools sollten im Client stets bestätigt werden.

> **Vor einer Exposition ins Internet:** Der PIN-Zugang ist für den lokalen Betrieb
> ausgelegt. Wird das Dashboard von außen erreichbar, sind ein zweiter Faktor oder
> eine IP-Allowlist im nginx erforderlich, ebenso TLS.

## Entwicklung

```bash
npm install
npm run secrets              # .env erzeugen

docker compose up -d postgres
npm run db:migrate

npm run dev                  # Backend auf Port 8080
npm run dev:web              # Dashboard auf Port 5173

npm test                     # 86 Tests
npm run typecheck
npm run build
```

### Aufbau

```
src/
  shared/    Konfiguration, Verschlüsselung, Fehler, Toolsets, Token-Schätzung
  db/        Drizzle-Schema, Migrationen
  jama/      REST-Client: Auth, Rate-Limiter, Cache, Schema-Auflösung, Aufbereitung
  mcp/       Tool-Verzeichnis, Guards, Server-Aufbau, Prompts, HTTP-Route
  admin/     PIN-Authentifizierung, Admin-API
  service/   Key-Auflösung, Einstellungen, Nutzung und Audit
web/         Admin-Dashboard (React, Tailwind, lucide, Recharts)
```

### Dokumentation

- [docs/KONZEPT.md](docs/KONZEPT.md) — Architektur, 51 Anwendungsfälle, Tool-Katalog, Datenmodell
- [docs/vergleich-mcp.md](docs/vergleich-mcp.md) — Gegenüberstellung mit dem offiziellen Jama MCP
- `python3 docs/generate_pdfs.py` erzeugt beide Dokumente als PDF

## Bekannte Einschränkungen

- Nicht gegen eine reale Jama-Instanz verifiziert (siehe oben).
- Massenoperationen sind **nicht atomar**. Bei einem Teilfehler wird ausdrücklich
  gemeldet, was angelegt wurde und was nicht — zurückgerollt wird nichts.
- Die `labs`-Endpunkte für Reviews und Reports bietet Jama ohne Supportzusage an;
  je nach Version fehlen sie. Die betroffenen Tools erkennen das und melden es.
- Die Suche ist rein textbasiert, wie Jamas API selbst. Keine semantische Suche.
- Der Cache liegt im Prozess. Für einen Betrieb mit mehreren Instanzen wäre ein
  gemeinsamer Speicher nötig; das Cache-Interface ist dafür vorbereitet.
- Ein OAuth-Token-Abruf läuft am Rate-Limiter vorbei. Bei einer Token-Laufzeit von
  einer Stunde ist das gegenüber dem Budget nicht relevant.

## Lizenz

MIT — siehe [LICENSE](LICENSE).

Dieses Projekt steht in keiner Verbindung zu Jama Software. „Jama Connect" ist eine
Marke von Jama Software, Inc.
