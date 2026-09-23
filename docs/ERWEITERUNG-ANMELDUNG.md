# Erweiterung: Anmeldung über den Firmenzugang

Verbindlicher Vertrag. Abweichungen gehören erst hierher und dann in den Code.

## Warum

Die Personenmatrix aus `docs/ERWEITERUNG-RECHTE.md` braucht eine **Person**.
Heute kommt keine an: Open WebUI reicht die Benutzerkopfzeilen nicht an
MCP-Server über Streamable HTTP weiter (open-webui Nr. 21134 / 21184, offen seit
Februar 2026), und auch Platzhalter wie `{{USER_EMAIL}}` in eigenen Kopfzeilen
werden wörtlich verschickt statt ersetzt.

Der Ausweg ist besser als der ursprüngliche Plan. Open WebUI unterstützt für
MCP-Verbindungen **OAuth 2.1**. Damit wird die Identität **nachgewiesen** statt
behauptet — und genau das verlangt die Anforderung, dass sich die Grenze nicht
durch geschicktes Formulieren umgehen lässt.

Der Anmeldedienst ist der Firmenzugang (Entra ID), der ohnehin schon vor Open
WebUI steht. **Wir bauen keinen Anmeldedienst, wir prüfen nur Token.**

## Die Rollenverteilung

| Rolle | Wer |
|---|---|
| Anmeldedienst (Authorization Server) | Entra ID |
| Geschützte Ressource (Resource Server) | dieser Dienst |
| Client | Open WebUI |

Entra kann **keine dynamische Registrierung**. Open WebUI wird deshalb als
autorisierter Client in der App-Registrierung dieses Dienstes hinterlegt
(„OAuth 2.1 (Static)" in der Verbindungseinrichtung).

## Der Ablauf

1. Open WebUI ruft `/mcp` ohne Token auf.
2. Der Dienst antwortet **401** mit
   `WWW-Authenticate: Bearer resource_metadata="<Basis>/.well-known/oauth-protected-resource"`.
3. Open WebUI liest dieses Dokument (RFC 9728), findet darin den Anmeldedienst
   und die Kennung dieser Ressource.
4. Open WebUI holt bei Entra ein Token für genau diese Ressource (RFC 8707).
5. Der Dienst prüft das Token und kennt damit die Person.

Ohne Schritt 2 findet ein Client den Anmeldedienst nie. Der Kopf ist keine
Höflichkeit, er ist der Einstieg in die ganze Kette.

## Konfiguration (Umgebung, nicht Datenbank)

```
ENTRA_ISSUER        https://login.microsoftonline.com/<tenant>/v2.0
ENTRA_AUDIENCE      api://<kennung-dieses-dienstes>
ENTRA_SCOPE         mcp.use            (optional, Vorgabe: mcp.use)
ENTRA_JWKS_URL      (optional; sonst aus dem Aussteller abgeleitet)
```

**In der Umgebung und nicht im Dashboard**, weil der Aussteller darüber
entscheidet, wem dieser Dienst glaubt. Wer ihn zur Laufzeit ändern kann, kann
sich eine eigene Identität ausstellen.

Fehlen die Angaben, bleibt der Weg abgeschaltet und alles verhält sich wie
heute. Das Einschalten ist eine bewusste Handlung.

## `src/auth/entra.ts` (neu)

```ts
export interface Tokenperson {
  /** Unveraenderliche Kennung aus dem Firmenzugang (oid). */
  kennung: string;
  email?: string;
  anmeldename?: string;
  name?: string;
}

export function entraEingerichtet(): boolean;
export async function pruefeToken(token: string): Promise<Tokenperson>;   // wirft bei ungueltig
export function leereSchluesselspeicher(): void;                          // fuer Tests
```

Geprüft wird, ohne Ausnahme:

- **Signatur** gegen den öffentlichen Schlüssel von Entra (JWKS, über `kid`).
- **Aussteller** exakt gleich `ENTRA_ISSUER`.
- **Empfänger** (`aud`) exakt gleich `ENTRA_AUDIENCE`. Das ist die Bindung an
  diese Ressource nach RFC 8707 — ohne sie taugt ein Token für einen ganz
  anderen Dienst auch hier.
- **Laufzeit** (`exp`, `nbf`) mit einer knappen Toleranz von 60 Sekunden für
  auseinanderlaufende Uhren.
- **Berechtigung**: `scp` oder `roles` enthält die verlangte Berechtigung.
- **Verfahren**: nur `RS256`. `alg: none` und symmetrische Verfahren werden
  abgewiesen, bevor irgendetwas anderes geschieht.

Die öffentlichen Schlüssel werden zwischengespeichert (eine Stunde) und bei
unbekanntem `kid` **einmal** neu geholt, höchstens alle fünf Minuten. Ohne
diese Bremse lässt sich der Dienst über erfundene `kid`-Werte in eine Schleife
von Abrufen treiben.

**Die Adresse der Schlüssel — hier stand erst eine falsche Vorgabe.** Ein
Entra-Aussteller endet auf `/v2.0`. Wer daran `/discovery/v2.0/keys` anhängt,
landet bei `…/<tenant>/v2.0/discovery/v2.0/keys` und bekommt einen 404. Richtig
ist: das abschließende `/v2.0` abschneiden, dann `/discovery/v2.0/keys`.

Der Weg über `/.well-known/openid-configuration` wäre allgemeiner, kostet aber
eine zweite Anfrage je Nachladen und bringt ein Dokument mit, dessen `jwks_uri`
man erst gegen den Aussteller prüfen müsste, bevor man ihr folgt.
`ENTRA_JWKS_URL` ist der Ausweg für abweichende Aussteller.

Keine Bibliothek für das Token selbst; Node bringt mit `node:crypto` alles mit,
was für RS256 und JWKS nötig ist. **Niemals ein Token protokollieren** — auch
nicht gekürzt.

## Entdeckung

`GET /.well-known/oauth-protected-resource` liefert, ohne Anmeldung:

```json
{
  "resource": "<ENTRA_AUDIENCE>",
  "authorization_servers": ["<ENTRA_ISSUER>"],
  "scopes_supported": ["<ENTRA_SCOPE>"],
  "bearer_methods_supported": ["header"]
}
```

Ist Entra nicht eingerichtet, antwortet der Pfad mit **404** — ein Dokument,
das auf nichts verweist, schickt Clients in die Irre.

## Verdrahtung in `src/mcp/http-route.ts`

Zwei Wege zur Identität, beide münden in dieselbe `Rechtelage`:

| Vorgelegt | Auflösung | `person.erkannt` |
|---|---|---|
| Zugangsschlüssel dieses Dienstes | wie bisher | nur über Kopfzeilen, also praktisch nie |
| Token aus dem Firmenzugang | `pruefeToken` → `findeJamaBenutzerId` | **ja** |

Unterschieden wird an der Form des Bearer-Werts: Ein Token hat drei durch
Punkte getrennte Teile und beginnt mit `eyJ`. Alles andere ist ein
Zugangsschlüssel. Raten ist hier zulässig, weil beide Wege anschließend
vollständig geprüft werden — ein falsch geratener Weg endet in einer Ablehnung,
nie in einem Zugang.

**Der Zugangsschlüssel bleibt.** Dienstkonten, der Einzelplatzbetrieb und
Clients ohne OAuth brauchen ihn weiterhin.

Ein Token allein sagt noch nicht, **welcher** Zugang gilt. Bis das geklärt ist:
Der Aufruf braucht zusätzlich die Kopfzeile `X-Jama-Zugang` mit dem Präfix des
Zugangs, oder es gibt genau einen Zugang mit eingeschalteter Personenmatrix,
dann gilt dieser. Trifft beides nicht zu, wird mit einer verständlichen Meldung
abgelehnt. **Nicht raten.**

## Harte Vorgaben

- Kein Token, kein Geheimnis und keine Kopfzeile im Protokoll.
- Nutzersichtbare deutsche Texte mit echten Umlauten.
- Keine Kunden-, Firmen- oder Personennamen; Beispiele mit `example.com`.
- Keine TODOs, keine toten Pfade.
