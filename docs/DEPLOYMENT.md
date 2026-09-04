# Deployment

Zwei Varianten, je nachdem was in der Zielumgebung schon läuft:

| Variante | Datei | Wann |
|---|---|---|
| **Alles inklusive** | `docker-compose.yml` | Nichts vorhanden — bringt nginx und PostgreSQL mit |
| **Nur die Anwendung** | `docker-compose.traefik.yml` | Traefik und PostgreSQL sind bereits da |

---

# Variante A: bestehende PostgreSQL und Traefik nutzen

Läuft in der Umgebung schon ein Reverse-Proxy und eine Datenbank, ist nginx und
ein zweiter PostgreSQL-Container überflüssig. Dann genügt der `app`-Dienst.

## Datenbank vorbereiten

Eigener Benutzer, eigene Datenbank — nicht in eine bestehende Datenbank mischen.
Der Dienst legt sieben Tabellen an (`api_keys`, `usage_events`, `audit_log`,
`admin_sessions`, `login_attempts`, `jama_connections`, `settings`); einige
dieser Namen sind generisch genug, um in einer geteilten Datenbank zu
kollidieren.

```sql
CREATE USER jama_mcp WITH PASSWORD '<starkes-passwort>';
CREATE DATABASE jama_mcp OWNER jama_mcp;

-- Nur der eigene Benutzer darf hinein.
REVOKE ALL ON DATABASE jama_mcp FROM PUBLIC;
GRANT CONNECT ON DATABASE jama_mcp TO jama_mcp;
```

Der Benutzer braucht Rechte zum Anlegen von Tabellen — die Migrationen laufen
beim Start automatisch mit. Als Eigentümer der Datenbank hat er sie.

## Stack starten

`.env` neben der Compose-Datei anlegen:

```bash
DATABASE_URL=postgres://jama_mcp:<passwort>@<db-host>:5432/jama_mcp
ENCRYPTION_KEY=<openssl rand -base64 32>
SESSION_SECRET=<openssl rand -base64 32>
ADMIN_INITIAL_PIN=<8 Ziffern>

PUBLIC_BASE_URL=https://jama-mcp.example.com
JAMA_MCP_HOST=jama-mcp.example.com

TRAEFIK_NETWORK=traefik
TRAEFIK_ENTRYPOINT=websecure
```

```bash
docker compose -f docker-compose.traefik.yml up -d --build
```

**Zum `db-host`:** Läuft die PostgreSQL als Container im selben Docker-Netz,
ist ihr Service-Name der Host. Läuft sie auf dem Docker-Host selbst, ist es
`host.docker.internal` — unter Linux zusätzlich den `extra_hosts`-Block in der
Compose-Datei aktivieren.

### Wenn Proxy und Datenbank in verschiedenen Netzen liegen

Der häufigste Fall, sobald die Datenbank zu einem anderen Stack gehört. Prüfen:

```bash
docker inspect <db-container> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

Taucht dort das Proxy-Netz nicht auf, hängt die App zusätzlich ins Datenbank-Netz —
dafür liegt ein fertiges Override bei:

```bash
echo "DB_NETWORK=<netz-der-datenbank>" >> .env
docker compose -f docker-compose.traefik.yml -f docker-compose.dbnet.yml up -d
```

### TLS-Zertifikate

Die Compose-Datei setzt bewusst **keinen** `certresolver`. Viele Traefik-Installationen
verwalten ihre Zertifikate zentral und kennen gar keinen Resolver — ein unbekannter
Name lässt den Router dort stillschweigend scheitern. Wer einen Resolver betreibt,
kommentiert die entsprechende Zeile in den Labels ein.

## Ein Traefik-Detail, das leicht übersehen wird

MCP nutzt Streamable HTTP und liefert Antworten als Ereignisstrom. Ohne kurzes
Flush-Intervall puffert Traefik den Strom, und der Client bekommt die Antwort
erst am Ende — bei längeren Tool-Aufrufen läuft er vorher in einen Timeout.
Deshalb steht in der Compose-Datei:

```yaml
- "traefik.http.services.jama-mcp.loadbalancer.responseForwarding.flushInterval=1ms"
```

Da Traefik das TLS übernimmt, muss `PUBLIC_BASE_URL` mit `https://` beginnen.
Die Anwendung setzt daraufhin automatisch das `Secure`-Flag auf den Cookies und
liefert HSTS aus. Die übrigen Sicherheits-Header setzt sie ohnehin selbst.

---

# Variante B: alles inklusive, mit Portainer

Portainer kann den Stack direkt aus diesem Repository bauen — es genügt die
Repository-URL. Vier Umgebungsvariablen musst du allerdings selbst setzen, weil
sie Geheimnisse sind und bewusst nicht im Repository liegen.

## 1. Secrets erzeugen

Auf einem beliebigen Rechner mit `openssl` (auch direkt auf dem Server):

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)"
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"
echo "SESSION_SECRET=$(openssl rand -base64 32)"
echo "ADMIN_INITIAL_PIN=$(LC_ALL=C tr -dc '0-9' </dev/urandom | head -c 8)"
```

Die vier Werte notieren. `ENCRYPTION_KEY` und `SESSION_SECRET` müssen exakt
32 Byte base64-kodiert sein — genau das liefert `openssl rand -base64 32`.

> **`ENCRYPTION_KEY` niemals nachträglich ändern.** Er verschlüsselt die
> hinterlegten Jama-Zugangsdaten. Wird er ausgetauscht, sind alle gespeicherten
> Zugangsdaten unlesbar und müssen neu eingegeben werden.

## 2. Stack in Portainer anlegen

**Stacks → Add stack → Repository**

| Feld | Wert |
|---|---|
| Name | `jama-mcp` |
| Repository URL | `https://github.com/greeves89/jama-mcp-service` |
| Repository reference | `refs/heads/main` |
| Compose path | `docker-compose.yml` |

**Wichtig:** Den Schalter **„Enable relative path volumes"** aktivieren. Der Stack
bindet die nginx-Konfiguration über relative Pfade ein (`./nginx/nginx.conf`).
Ohne diesen Schalter findet Portainer die Dateien nicht und der nginx-Container
startet nicht.

## 3. Umgebungsvariablen eintragen

Im selben Dialog unter **Environment variables**:

### Zwingend erforderlich

| Variable | Wert | Ohne sie |
|---|---|---|
| `POSTGRES_PASSWORD` | aus Schritt 1 | Datenbank startet nicht |
| `ENCRYPTION_KEY` | aus Schritt 1 | Anwendung bricht beim Start ab |
| `SESSION_SECRET` | aus Schritt 1 | Anwendung bricht beim Start ab |
| `ADMIN_INITIAL_PIN` | aus Schritt 1 | Dienst läuft, aber du kommst nicht ins Dashboard |
| `PUBLIC_BASE_URL` | `http://<server-ip>:8081` | Die Konfigurationsschnipsel für MCP-Clients zeigen auf `localhost` und funktionieren nicht |

### Häufig sinnvoll

| Variable | Standard | Wozu |
|---|---|---|
| `NGINX_PORT` | `8081` | Externer Port, falls 8081 belegt ist |
| `JAMA_RATE_LIMIT_RPS` | `6` | Anfragen pro Sekunde gegen Jama. Jama drosselt bei 10 für die **gesamte** Instanz — der Standard lässt bewusst Luft für andere Integrationen |
| `GLOBAL_READ_ONLY` | `false` | Auf `true` setzen, um von Anfang an jeden Schreibzugriff zu sperren |
| `TRUST_PROXY_HOPS` | `1` | Anzahl der Proxys vor dem Dienst. Aus dieser Zahl leitet sich ab, welchem Teil von `X-Forwarded-For` zu trauen ist — und damit die Client-Adresse, auf der die Anmeldesperre beruht. `1` passt für genau einen nginx oder Traefik davor. Steht zusätzlich ein CDN davor, erhöhen; ein zu hoher Wert erlaubt es, die Sperre mit einer erfundenen Adresse zu umgehen, ein zu niedriger sperrt alle Benutzer gemeinsam aus. |
| `LOG_LEVEL` | `info` | Auf `info` erscheinen alle abgewiesenen und fehlgeschlagenen Anfragen mit Grund, dazu fehlgeschlagene Verbindungstests und Tool-Aufrufe. `debug` protokolliert zusätzlich jede erfolgreiche Anfrage — nützlich zur Fehlersuche, im Dauerbetrieb zu geschwätzig. |

Dann **Deploy the stack**.

## 4. Was beim ersten Start passiert

1. Portainer klont das Repository und baut das Image (`npm ci`, TypeScript-Build,
   Vite-Build). **Das dauert je nach Server zwei bis fünf Minuten.**
2. PostgreSQL startet und meldet sich über seinen Health-Check bereit.
3. Die Anwendung führt die Datenbank-Migrationen aus und übernimmt den
   `ADMIN_INITIAL_PIN` als Argon2id-Hash.
4. nginx startet, sobald die Anwendung gesund ist.

Prüfen:

```bash
curl http://<server-ip>:8081/health
# {"status":"ok","datenbank":true,"tools":53,...}
```

Dashboard: `http://<server-ip>:8081/admin/`

Nach der ersten Anmeldung kannst du `ADMIN_INITIAL_PIN` aus den
Stack-Variablen entfernen — der PIN liegt dann als Hash in der Datenbank.

## Voraussetzungen an die Umgebung

- **Docker Standalone**, nicht Swarm. Der Stack nutzt `build:`; das
  unterstützt Portainer nur bei Standalone-Umgebungen.
- **Mindestens 2 GB RAM** für den Build. Der Vite-Build ist der speicherhungrigste
  Schritt. Auf kleineren Maschinen bricht er mit einem Speicherfehler ab —
  in dem Fall das Image auf einem anderen Rechner bauen und in eine Registry
  schieben (siehe unten).
- **Etwa 1,5 GB Plattenplatz** für Image und Build-Zwischenschichten.

## Aktualisieren

Bei Änderungen im Repository: **Stack → Pull and redeploy**. Portainer holt den
neuen Stand und baut neu. Die Datenbank bleibt erhalten, weil sie im benannten
Volume `pgdata` liegt. Migrationen laufen beim Start automatisch mit.

## Wenn der Build auf dem Server nicht durchläuft

Image anderswo bauen und aus einer Registry ziehen:

```bash
docker build -t <registry>/jama-mcp:1.0.0 .
docker push <registry>/jama-mcp:1.0.0
```

Dann im Stack den `build:`-Block des `app`-Dienstes durch
`image: <registry>/jama-mcp:1.0.0` ersetzen.

---

## Sicherheit: vor einer Exposition ins Internet lesen

Der Dienst ist für den Betrieb im internen Netz ausgelegt. Wird er von außen
erreichbar, fehlt Folgendes:

| Lücke | Warum das zählt |
|---|---|
| **Kein TLS** | Der PIN und die Session-Cookies gingen im Klartext über die Leitung. nginx liefert nur HTTP aus |
| **Nur PIN als Zugang** | Acht Ziffern. Argon2id und die IP-Sperre nach fünf Fehlversuchen machen ihn tragfähig, aber nicht gegen einen entschlossenen Angreifer aus dem Internet |
| **Gespeicherte Jama-Zugangsdaten** | Bei einer Kompromittierung des Servers stehen sie zwar verschlüsselt, aber der `ENCRYPTION_KEY` liegt in derselben Umgebung |

Mindestens erforderlich, bevor der Dienst öffentlich erreichbar wird:

1. **TLS** — Reverse-Proxy davor (Traefik, Caddy oder nginx mit Let's Encrypt)
   und `PUBLIC_BASE_URL` auf `https://…` setzen. Dann setzt die Anwendung
   automatisch `Secure` auf den Cookies und liefert HSTS aus.
2. **Zugang einschränken** — IP-Allowlist im nginx, ein VPN davor oder eine
   zusätzliche Authentifizierung am Reverse-Proxy.
3. **Firewall** — nur die tatsächlich benötigten Ports offen. Datenbank und
   Anwendung haben im Stack ohnehin kein Port-Mapping nach außen.
4. **Backups** des `pgdata`-Volumes, bevor produktiv damit gearbeitet wird.

Für den reinen Test im Heimnetz oder Firmen-LAN ist der Stack so, wie er ist,
in Ordnung.


## Logs

Der Dienst schreibt strukturiert nach stdout, wie es bei Containern üblich ist.
Ausgelesen wird also über Docker:

```bash
docker compose logs -f app          # laufend mitlesen
docker compose logs --tail 200 app  # letzte 200 Zeilen
```

Was auf der Standardstufe `info` erscheint:

- jede Anfrage ab Status 400, mit Methode, Pfad, Status, Dauer und Client-Adresse
- der Grund dazu (Fehlercode und Klartextmeldung)
- fehlgeschlagene Verbindungstests samt Meldung von Jama — diese antworten mit
  HTTP 200, weil der Test technisch durchlief, und wären sonst unsichtbar
- fehlgeschlagene Tool-Aufrufe mit Fehlercode und redigierten Argumenten
- Start, Migrationen, Wartungslauf und geordnetes Beenden

Erfolgreiche Anfragen werden bewusst nicht protokolliert: Das Dashboard erzeugt
pro Seitenaufruf ein Vielfaches an Anfragen und würde alles Übrige verdecken.
Wer sie braucht, setzt `LOG_LEVEL=debug`.

### Fehlersuche: alles mitlesen

Für die Fehlersuche gibt es eine gesprächigere Stufe:

```bash
# In der .env setzen, dann neu starten
LOG_LEVEL=debug
```

Zusätzlich erscheint dann:

- **jeder einzelne Aufruf an Jama** mit Methode, Pfad, Status, Dauer und
  Versuchsnummer — daran ist zu sehen, welche Adressen der Dienst überhaupt
  anspricht und ob wiederholt werden musste
- jede erfolgreiche Anfrage an den Dienst selbst

Fehlgeschlagene Jama-Aufrufe erscheinen **unabhängig vom Log-Level**, samt der
Antwort von Jama (auf 500 Zeichen gekürzt). Dasselbe gilt für eine
fehlgeschlagene Anmeldung: Dort steht Jamas OAuth-Antwort im Klartext, also
`invalid_client`, `invalid_grant` oder die zugehörige Beschreibung — und damit
die eigentliche Ursache. Zur Unterscheidung mehrerer hinterlegter Zugänge wird
der Anfang der Client-ID mitgeschrieben, nie das Secret.

Im Dauerbetrieb gehört `LOG_LEVEL` wieder auf `info`: Auf `debug` erzeugt schon
ein einzelner Tool-Aufruf mehrere Einträge, und die 100 MB je Container sind
entsprechend schneller erreicht.

Was **niemals** im Log landet, unabhängig von der Stufe: Zugangsdaten, Tokens,
Cookies, PINs (sie werden vor der Ausgabe ersetzt) sowie die fachlichen Inhalte
der Jama-Items — Anforderungstexte können personenbezogene oder vertrauliche
Angaben enthalten und haben in einem Betriebsprotokoll nichts zu suchen.

Zugangsdaten, Tokens, Cookies und PINs werden vor der Ausgabe ersetzt; Inhalte
aus Jama-Items landen grundsätzlich nicht im Log.

### Größe

Die Logdateien sind je Container auf **fünf Dateien zu je 20 MB begrenzt**, also
höchstens 100 MB. Ist die Grenze erreicht, wird die älteste Datei verworfen.
Ohne diese Angabe wächst die JSON-Datei des Docker-Logtreibers unbegrenzt —
Docker räumt dort von sich aus nichts auf, und auf kleinen Maschinen läuft
darüber irgendwann die Platte voll.

Die Werte stehen in den Compose-Dateien unter `x-logging` und gelten über einen
YAML-Anker für alle Dienste. Zum Ändern genügt die eine Stelle:

```yaml
x-logging: &logging
  driver: "json-file"
  options:
    max-size: "20m"
    max-file: "5"
```

Bereits laufende Container übernehmen die Änderung erst nach einem Neuaufbau
(`docker compose up -d`), weil der Logtreiber beim Erzeugen des Containers
festgelegt wird.


## Client-Adresse hinter dem Reverse-Proxy

Die Anmeldesperre des Dashboards zählt Fehlversuche pro Client-Adresse. Diese
Adresse stammt aus `X-Forwarded-For` — also aus einem Header, den grundsätzlich
auch der Client selbst mitschicken kann. Zwei Dinge müssen deshalb stimmen,
sonst lässt sich die Sperre mit einer erfundenen Adresse umgehen.

**1. Der Proxy muss den Header setzen, nicht anhängen.**

Der mitgelieferte nginx tut das bereits (`proxy_set_header X-Forwarded-For
$remote_addr` in `nginx/proxy_params_jama.conf`). Wer die Traefik-Variante
nutzt, bindet ein **bereits vorhandenes** Traefik ein, das dieses Repository
nicht konfiguriert — dort ist selbst zu prüfen:

- `forwardedHeaders.insecure` darf **nicht** gesetzt sein
- `forwardedHeaders.trustedIPs` darf nur die eigenen vorgelagerten Proxys
  enthalten, nicht etwa `0.0.0.0/0`

Andernfalls reicht Traefik einen vom Client gesetzten `X-Forwarded-For`
unverändert durch, und die Lücke besteht eine Ebene weiter außen fort.

**2. `TRUST_PROXY_HOPS` muss zur Anzahl der Proxys passen.**

Standard ist `1` und damit richtig für genau einen nginx oder ein Traefik vor
dem Dienst. Steht zusätzlich ein CDN oder ein weiterer Load Balancer davor,
entsprechend erhöhen. Ein zu hoher Wert macht die Sperre umgehbar, ein zu
niedriger lässt alle Anfragen von derselben Adresse kommen — dann sperrt ein
einziger Fehlversuch alle Benutzer gemeinsam aus.

> **Der Anwendungs-Port darf niemals direkt nach außen gemappt werden.** Beide
> Compose-Dateien nutzen dafür ausschließlich `expose:`. Wird zum Debuggen ein
> `ports: ["8080:8080"]` ergänzt, kann sich jeder direkt verbindende Client
> selbst als der eine vertraute Proxy ausgeben und eine beliebige Adresse
> einschleusen — die gesamte Absicherung oben ist dann wirkungslos.


## Wer hat die Änderung veranlasst?

Jama führt eine eigene Historie, dort steht aber nur der technische Benutzer,
unter dem diese Anbindung arbeitet. Teilen sich mehrere Personen einen Zugang —
der Regelfall bei einem Chat-Werkzeug —, ist im Nachhinein nicht mehr
feststellbar, wer eine Anforderung angelegt oder geändert hat.

Dafür gibt es im Dashboard unter **Einstellungen → Nachvollziehbarkeit** den
Schalter **Herkunft als Kommentar in Jama vermerken**. Ist er aktiv, erhält
jedes angelegte oder geänderte Item einen Kommentar:

```
Angelegt über die Jama-Anbindung durch Erika Musterfrau
<erika@example.com> (Zugang: Jama-dev01).
```

Der Vermerk kostet einen zusätzlichen Jama-Aufruf je Item und fällt deshalb bei
Massenanlagen ins Gewicht. Schlägt er fehl, wird die Änderung selbst **nicht**
zurückgenommen — sie ist zu diesem Zeitpunkt bereits geschehen; der Fehlschlag
landet im Log.

### Woher die Person kommt

Der Dienst liest sie aus den Kopfzeilen der Anfrage, in dieser Reihenfolge:

| Angabe | Kopfzeilen |
|---|---|
| Name | `X-OpenWebUI-User-Name`, `X-User-Name`, `X-Forwarded-User`, `X-Remote-User` |
| E-Mail | `X-OpenWebUI-User-Email`, `X-User-Email`, `X-Forwarded-Email` |
| Kennung | `X-OpenWebUI-User-Id`, `X-User-Id` |

**Einschränkung bei Open WebUI:** Diese Kopfzeilen werden gesendet, sobald
`ENABLE_FORWARD_USER_INFO_HEADERS=true` gesetzt ist — allerdings bislang nur an
OpenAI-kompatible Endpunkte, **noch nicht an MCP-Server über Streamable HTTP**
(open-webui Nr. 21184, zum Stand dieser Zeilen offen). Bis das nachgezogen ist,
steht im Kommentar nur der verwendete Zugang, und das wird dort ausdrücklich
gesagt statt eine Herkunft vorzutäuschen.

**Der zuverlässige Weg heute** ist deshalb ein eigener API-Key je Person, mit
den jeweils eigenen Jama-Zugangsdaten (`Art des Zugangs: Person`). Dann greifen
zusätzlich die Jama-Berechtigungen pro Benutzer, und schon Jamas eigene Historie
nennt den richtigen Verursacher — unabhängig davon, was der Client mitschickt.

### Keine Berechtigungsgrundlage

Die Angaben aus den Kopfzeilen sind eine Auskunft des Clients, kein Nachweis.
Wer den API-Key besitzt, kann jeden beliebigen Namen behaupten. Sie taugen für
die Nachvollziehbarkeit im Normalbetrieb; die Rechte hängen weiterhin
ausschließlich am Key. Steuerzeichen werden entfernt und die Länge begrenzt,
damit sich darüber weder Logzeilen fälschen noch fremder Text in Jama-Kommentare
schieben lässt.
