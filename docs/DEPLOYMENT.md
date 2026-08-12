# Deployment mit Portainer

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
| `LOG_LEVEL` | `info` | `debug` zur Fehlersuche |

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
