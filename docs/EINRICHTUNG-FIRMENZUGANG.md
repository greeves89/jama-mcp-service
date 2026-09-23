# Einrichtung: Anmeldung über den Firmenzugang

Diese Seite ist zum Weiterreichen an die IT gedacht. Sie beschreibt, was im
Verzeichnisdienst einzutragen ist, damit sich Personen an diesem Dienst
ausweisen können.

## Was damit erreicht wird

Bisher hängen die Rechte an einem Zugangsschlüssel. Teilen sich mehrere
Menschen einen Zugang, haben alle dieselben Rechte, und nach einer Änderung
lässt sich nicht mehr feststellen, wer sie veranlasst hat.

Nach dieser Einrichtung weist sich jede Person mit einem **signierten Token**
aus, das der Firmenzugang ausstellt. Der Dienst prüft dieses Token und kennt
damit die Person — nachweislich, nicht auf Zuruf.

Der Dienst wird dabei **nicht** zum Anmeldedienst. Er prüft nur, was der
Firmenzugang ausgestellt hat.

## Die Rollenverteilung

| Rolle | Wer |
|---|---|
| Anmeldedienst | der Firmenzugang (Entra ID) |
| Geschützte Schnittstelle | dieser Dienst |
| Anwendung, die sich anmeldet | das KI-Programm |

## Schritt 1 — Den Dienst als Schnittstelle registrieren

Eine App-Registrierung anlegen, die **diesen Dienst** vertritt:

1. Name frei wählbar, etwa „Anforderungs-Schnittstelle".
2. Unter **Eine API verfügbar machen** eine Anwendungs-ID-URI vergeben, zum
   Beispiel `api://anforderungen-mcp`. Dieser Wert ist später `ENTRA_AUDIENCE`.
3. Dort einen **Bereich** (Scope) anlegen:
   - Name: `mcp.use`
   - Wer kann zustimmen: Administratoren und Benutzer
   - Anzeigenamen und Beschreibung so wählen, dass sie im Zustimmungsdialog
     verständlich sind.

## Schritt 2 — Das KI-Programm als Client eintragen

Das KI-Programm meldet sich im Namen der Person an. Es muss deshalb berechtigt
sein, Token für die Schnittstelle aus Schritt 1 zu holen.

**Wichtig:** Eine dynamische Registrierung unterstützt der Firmenzugang nicht.
Es ist also der statische Weg zu gehen — im KI-Programm wird die Verbindung als
„OAuth 2.1 (Static)" eingerichtet, mit fest vergebener Client-Kennung und
Geheimnis.

1. Entweder eine eigene App-Registrierung für das KI-Programm anlegen und ihr
   unter **API-Berechtigungen** den Bereich `mcp.use` der Schnittstelle
   zuweisen — oder, falls das Programm bereits registriert ist, diese
   Berechtigung dort ergänzen.
2. Die Zustimmung für die Organisation erteilen, damit sie nicht jede Person
   einzeln bestätigen muss.
3. Ein Geheimnis erzeugen und notieren, wann es abläuft. **Ein abgelaufenes
   Geheimnis legt die Anmeldung still** — das ist der häufigste Grund, warum
   solche Anbindungen Monate später plötzlich nicht mehr funktionieren.

## Schritt 3 — Drei Werte zurückmelden

Aus der Registrierung werden drei Angaben gebraucht:

| Angabe | Wo sie steht | Beispiel |
|---|---|---|
| Aussteller | Endpunktübersicht der Registrierung, Feld „issuer" | `https://login.microsoftonline.com/<Verzeichnis-ID>/v2.0` |
| Kennung der Schnittstelle | die Anwendungs-ID-URI aus Schritt 1 | `api://anforderungen-mcp` |
| Name des Bereichs | der Scope aus Schritt 1 | `mcp.use` |

Diese drei Werte werden in der Umgebung des Dienstes hinterlegt
(`ENTRA_ISSUER`, `ENTRA_AUDIENCE`, `ENTRA_SCOPE`). Client-Kennung und Geheimnis
aus Schritt 2 werden **nicht** hier gebraucht, sondern im KI-Programm.

## Schritt 4 — Im KI-Programm eintragen

Die Verbindung zur Schnittstelle bekommt als Authentifizierung
**OAuth 2.1 (Static)** mit der Client-Kennung und dem Geheimnis aus Schritt 2.
Alles Weitere findet das Programm selbst: Der Dienst weist bei einem Aufruf
ohne Token darauf hin, wo der Anmeldedienst zu finden ist.

## Prüfen, ob es greift

```
curl -s <Basisadresse>/.well-known/oauth-protected-resource
```

Antwortet der Dienst mit einem Dokument, das Aussteller und Kennung nennt, ist
die Einrichtung auf unserer Seite aktiv. Antwortet er mit 404, fehlen die drei
Werte in der Umgebung.

## Was sich für die Anwender ändert

Beim ersten Aufruf einmal eine Zustimmung, danach nichts. Sie melden sich am
Firmenzugang an, an dem sie ohnehin angemeldet sind.

## Was sich nicht ändert

Der bisherige Zugangsschlüssel bleibt gültig. Dienstkonten, der
Einzelplatzbetrieb und Programme ohne OAuth laufen unverändert weiter. Die
neue Anmeldung tritt daneben, nicht an ihre Stelle.
